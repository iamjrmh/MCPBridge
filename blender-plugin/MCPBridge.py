"""
╔══════════════════════════════════════════════════════╗
║           Blender Ollama MCP Bridge Plugin           ║
║  Connects Blender to your local MCP server           ║
║  which routes commands from Claude Code + Ollama     ║
╚══════════════════════════════════════════════════════╝

INSTALL:
  1. Edit → Preferences → Add-ons → Install…
  2. Select this file  →  Enable "MCPBridge"
  3. Open any 3-D Viewport  →  Sidebar (N)  →  "MCPBridge" tab
  4. Click "Start Bridge"

REQUIREMENTS:
  • MCP bridge server must be running on localhost:7843
"""

bl_info = {
    "name":        "MCPBridge",
    "author":      "MCPBridge",
    "version":     (1, 1, 0),
    "blender":     (3, 0, 0),
    "location":    "View3D › Sidebar › MCPBridge",
    "description": "Connects Blender to the MCPBridge MCP server (Claude Code / Ollama)",
    "category":    "Development",
}

import bpy
import json
import ast
import contextlib
import io
import queue
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime


# ── Config ─────────────────────────────────────────────────────────────────

SERVER   = "http://127.0.0.1:7843"
POLL_HZ  = 2        # polls per second
HEARTBEAT = 5       # seconds between state pushes
VERSION  = "1.1.0"
MAX_OUTPUT_LINES = 400   # printed lines kept between pushes


# ── Global state ────────────────────────────────────────────────────────────
# All writes happen on the main thread (inside the timer or an operator).
# The poll thread only appends to _cmd_queue and reads _active.

_active        = False
_status        = "Inactive"
_last_cmd      = "—"
_log_lines     = []          # list[str] shown in the panel
_log_buffer    = []          # captured output waiting to be pushed to /state
_cmd_queue     = queue.Queue()  # commands delivered by poll thread → main thread
_poll_thread   = None
_last_heartbeat = 0.0


# ── Logging ──────────────────────────────────────────────────────────────────

def _append_log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    _log_lines.append(f"{ts} {msg}")
    if len(_log_lines) > 8:
        _log_lines[:] = _log_lines[-8:]


def _set_status(msg: str):
    global _status
    _status = msg


# ── Blender helpers ──────────────────────────────────────────────────────────

def _object_info(obj) -> dict:
    return {
        "name":      obj.name,
        "type":      obj.type,
        "path":      obj.name,
        "location":  list(obj.location),
        "visible":   obj.visible_get(),
    }


def _text_info(text) -> dict:
    return {
        "name":  text.name,
        "path":  text.name,
        "lines": len(text.lines),
    }


def _collect_scripts() -> list:
    return [_text_info(t) for t in bpy.data.texts]


# ── Command handlers  (all called on the main thread) ───────────────────────

def _jsonable(value, depth=0):
    """Turn any Blender/Python value into something json.dumps accepts."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if depth >= 8:
        return repr(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v, depth + 1) for v in value]
    if isinstance(value, bpy.types.ID):
        return f"{type(value).__name__}:{value.name}"
    try:
        # Vector, Color, Euler, Quaternion, Matrix and bpy arrays are sequences.
        return [_jsonable(v, depth + 1) for v in value]
    except TypeError:
        return repr(value)


def _handle_execute(payload: dict):
    """Run code; return the last expression (or __result__), what it printed, and any error."""
    code = payload.get("code", "")
    ns = {"bpy": bpy, "__name__": "__mcp__", "__result__": None}
    printed = io.StringIO()
    try:
        tree = ast.parse(code, "<mcp_execute>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
            ast.fix_missing_locations(last)
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
            exec(compile(tree, "<mcp_execute>", "exec"), ns)  # noqa: S102
            value = eval(compile(last, "<mcp_execute>", "eval"), ns) if last is not None else None  # noqa: S307
        if ns.get("__result__") is not None:
            value = ns["__result__"]
        result = {"ok": True, "values": [] if value is None else [_jsonable(value)]}
    except BaseException:  # noqa: BLE001 - the agent has to see every failure, SystemExit included
        result = {"ok": False, "error": traceback.format_exc()}
    lines = printed.getvalue().splitlines()
    result["output"] = lines[-MAX_OUTPUT_LINES:]
    _log_buffer.extend(lines)
    del _log_buffer[:-MAX_OUTPUT_LINES]
    return result


def _handle_object_info(payload: dict):
    name = payload.get("name", "")
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise KeyError(f"No object named '{name}'. Objects: {', '.join(o.name for o in bpy.data.objects[:40])}")
    info = {
        "name":       obj.name,
        "type":       obj.type,
        "location":   list(obj.location),
        "rotation":   list(obj.rotation_euler),
        "scale":      list(obj.scale),
        "dimensions": list(obj.dimensions),
        "visible":    obj.visible_get(),
        "parent":     obj.parent.name if obj.parent else None,
        "children":   [c.name for c in obj.children],
        "collections": [c.name for c in obj.users_collection],
        "materials":  [s.material.name for s in obj.material_slots if s.material],
        "modifiers":  [{"name": m.name, "type": m.type} for m in obj.modifiers],
        "customProperties": {k: _jsonable(v) for k, v in obj.items()},
    }
    if obj.type == "MESH" and obj.data is not None:
        mesh = obj.data
        info["mesh"] = {
            "vertices": len(mesh.vertices), "edges": len(mesh.edges), "polygons": len(mesh.polygons),
            "uvLayers": [uv.name for uv in mesh.uv_layers],
        }
    return info


def _handle_list_scripts(_payload: dict):
    return _collect_scripts()


def _handle_read_script(payload: dict):
    name = payload.get("path") or payload.get("name", "")
    text = bpy.data.texts.get(name)
    if text is None:
        raise KeyError(f"Text block '{name}' not found")
    return text.as_string()


def _handle_write_script(payload: dict):
    name   = payload.get("path") or payload.get("name", "")
    source = payload.get("source", "")
    text   = bpy.data.texts.get(name)
    if text is None:
        text = bpy.data.texts.new(name)
    text.clear()
    text.write(source)
    return True


def _handle_create_script(payload: dict):
    name   = payload.get("name", "untitled.py")
    source = payload.get("source", "")
    text   = bpy.data.texts.new(name)
    text.write(source)
    return name


def _handle_workspace_info(_payload: dict):
    scene = bpy.context.scene
    return {
        "fileName":    bpy.data.filepath or "(unsaved)",
        "objectCount": len(bpy.data.objects),
        "sceneCount":  len(bpy.data.scenes),
        "activeScene": scene.name if scene else None,
        "scriptCount": len(bpy.data.texts),
        "version":     VERSION,
    }


def _handle_get_selection(_payload: dict):
    return [_object_info(o) for o in bpy.context.selected_objects]


def _handle_scene_info(_payload: dict):
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        objects.append({
            "name":     obj.name,
            "type":     obj.type,
            "location": list(obj.location),
            "visible":  obj.visible_get(),
            "selected": obj.select_get(),
        })
    return {
        "fileName":    bpy.data.filepath or "(unsaved)",
        "activeScene": scene.name if scene else None,
        "objectCount": len(scene.objects),
        "objects":     objects,
        "activeObject": bpy.context.active_object.name if bpy.context.active_object else None,
        "renderEngine": scene.render.engine,
        "frameRange":  [scene.frame_start, scene.frame_end],
        "version":     VERSION,
    }


_HANDLERS = {
    "execute":        _handle_execute,
    "list_scripts":   _handle_list_scripts,
    "read_script":    _handle_read_script,
    "write_script":   _handle_write_script,
    "create_script":  _handle_create_script,
    "workspace_info": _handle_workspace_info,
    "scene_info":     _handle_scene_info,
    "object_info":    _handle_object_info,
    "get_selection":  _handle_get_selection,
}


# ── Command processing (main thread) ─────────────────────────────────────────

def _process_command(command: dict):
    global _last_cmd

    cmd_id   = command.get("id")
    cmd_type = command.get("type", "")
    payload  = command.get("payload") or {}

    _last_cmd = cmd_type
    _append_log(f"→ {cmd_type}")

    handler = _HANDLERS.get(cmd_type)
    if handler is None:
        body = json.dumps({
            "commandId": cmd_id,
            "result":    None,
            "error":     f"This add-on (v{VERSION}) does not know '{cmd_type}'. Install the newest blender-plugin/MCPBridge.py.",
        })
    else:
        try:
            result = handler(payload)
            body   = json.dumps({"commandId": cmd_id, "result": _jsonable(result), "error": None})
        except Exception as exc:
            _append_log(f"✗ {exc}")
            body = json.dumps({
                "commandId": cmd_id,
                "result":    None,
                "error":     traceback.format_exc(),
            })

    # Send result back — do this in a daemon thread so we don't block the UI
    def _post():
        try:
            req = urllib.request.Request(
                SERVER + "/result",
                data    = body.encode(),
                headers = {"Content-Type": "application/json"},
                method  = "POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as exc:
            _append_log(f"✗ POST /result failed: {exc}")

    threading.Thread(target=_post, daemon=True).start()


def _push_state():
    """Send current Blender state to /state.  Called from main thread."""
    global _log_buffer

    scripts  = _collect_scripts()
    captured = list(_log_buffer)
    _log_buffer.clear()

    body = json.dumps({
        "scripts": scripts,
        "output":  captured,
        "metadata": {
            "fileName":    bpy.data.filepath or "(unsaved)",
            "objectCount": len(bpy.data.objects),
        },
    })

    def _post():
        try:
            req = urllib.request.Request(
                SERVER + "/state",
                data    = body.encode(),
                headers = {"Content-Type": "application/json"},
                method  = "POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    threading.Thread(target=_post, daemon=True).start()


# ── Poll thread (HTTP only — no bpy calls) ────────────────────────────────────

def _poll_loop():
    """Background thread: hits /poll, queues commands for the main thread."""
    while _active:
        try:
            with urllib.request.urlopen(SERVER + "/poll?v=" + VERSION, timeout=10) as resp:
                data = json.loads(resp.read())

            _set_status("🟢 Connected")

            if data.get("hasCommand"):
                _cmd_queue.put(data["command"])

        except urllib.error.URLError:
            _set_status("🔴 Disconnected — retrying…")
            _append_log("Poll error: server unreachable")
        except Exception as exc:
            _set_status("🔴 Error")
            _append_log(f"Error: {exc}")

        time.sleep(1.0 / POLL_HZ)


# ── Blender timer (runs on main thread, ~10 Hz) ──────────────────────────────

def _main_thread_tick():
    """
    Called by bpy.app.timers on the main thread.
    Drains the command queue and triggers periodic state pushes.
    """
    if not _active:
        return None  # unregister timer

    global _last_heartbeat

    # Drain all pending commands
    while not _cmd_queue.empty():
        try:
            cmd = _cmd_queue.get_nowait()
            _process_command(cmd)
        except queue.Empty:
            break

    # Periodic heartbeat / state push
    now = time.monotonic()
    if now - _last_heartbeat > HEARTBEAT:
        _last_heartbeat = now
        _push_state()

    # Redraw any open 3-D views so the panel updates
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()

    return 0.1  # call again in 100 ms


# ── Bridge start / stop ───────────────────────────────────────────────────────

def start_bridge():
    global _active, _poll_thread, _last_heartbeat

    _active          = True
    _last_heartbeat  = 0.0
    _set_status("🟡 Connecting…")
    _append_log(f"Starting bridge  →  {SERVER}")

    _poll_thread = threading.Thread(target=_poll_loop, daemon=True)
    _poll_thread.start()

    if not bpy.app.timers.is_registered(_main_thread_tick):
        bpy.app.timers.register(_main_thread_tick, first_interval=0.1, persistent=True)


def stop_bridge():
    global _active, _poll_thread

    _active      = False
    _poll_thread = None
    _set_status("Inactive")
    _append_log("Bridge stopped.")

    if bpy.app.timers.is_registered(_main_thread_tick):
        bpy.app.timers.unregister(_main_thread_tick)


# ── Operators ─────────────────────────────────────────────────────────────────

class MCPBRIDGE_OT_toggle(bpy.types.Operator):
    bl_idname  = "mcpbridge.toggle"
    bl_label   = "Toggle MCP Bridge"
    bl_options = {"REGISTER"}

    def execute(self, context):
        if _active:
            stop_bridge()
        else:
            start_bridge()
        return {"FINISHED"}


class MCPBRIDGE_OT_clear_log(bpy.types.Operator):
    bl_idname  = "mcpbridge.clear_log"
    bl_label   = "Clear Log"
    bl_options = {"REGISTER"}

    def execute(self, context):
        _log_lines.clear()
        return {"FINISHED"}


# ── Panel ─────────────────────────────────────────────────────────────────────

class MCPBRIDGE_PT_panel(bpy.types.Panel):
    bl_label      = "MCP Bridge"
    bl_idname     = "MCPBRIDGE_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category   = "MCPBridge"

    def draw(self, context):
        layout = self.layout

        # ── Header ───────────────────────────────────────────────────
        row = layout.row()
        row.label(text=f"● OllamaMCP  v{VERSION}", icon="NETWORK_DRIVE")

        layout.separator(factor=0.5)

        # ── Status / last command ─────────────────────────────────────
        col = layout.column(align=True)
        col.label(text=f"Status:    {_status}")
        col.label(text=f"Last cmd:  {_last_cmd}")

        layout.separator(factor=0.5)

        # ── Toggle button ─────────────────────────────────────────────
        if _active:
            layout.operator(
                "mcpbridge.toggle",
                text="Stop Bridge",
                icon="PAUSE",
                depress=True,
            )
        else:
            layout.operator(
                "mcpbridge.toggle",
                text="Start Bridge",
                icon="PLAY",
            )

        layout.separator(factor=0.5)

        # ── Log box ───────────────────────────────────────────────────
        box = layout.box()
        header = box.row()
        header.label(text="Log", icon="TEXT")
        header.operator("mcpbridge.clear_log", text="", icon="X")

        if _log_lines:
            col = box.column(align=True)
            for line in _log_lines:
                col.label(text=line)
        else:
            box.label(text="(no activity yet)", icon="INFO")


# ── Registration ──────────────────────────────────────────────────────────────

_CLASSES = (
    MCPBRIDGE_OT_toggle,
    MCPBRIDGE_OT_clear_log,
    MCPBRIDGE_PT_panel,
)


def register():
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    _append_log(f"Plugin loaded  v{VERSION}")
    _append_log("Click 'Start Bridge' to connect.")


def unregister():
    stop_bridge()
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
