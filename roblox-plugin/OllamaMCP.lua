--[[
    ╔══════════════════════════════════════════════════════╗
    ║         Roblox Ollama MCP Bridge Plugin              ║
    ║  Connects Roblox Studio to your local MCP server     ║
    ║  which routes commands from Claude Code + Ollama     ║
    ╚══════════════════════════════════════════════════════╝

    INSTALL:
    1. Open Roblox Studio → Plugins → Plugin Folder
    2. Save this file as "OllamaMCP.lua" in that folder
    3. Restart Studio — the "OllamaMCP" toolbar button appears
    4. Click it to start the bridge

    REQUIREMENTS:
    • Studio → File → Settings → Studio → Enable HTTP Requests = ✓
    • MCP bridge server must be running on localhost:7842
]]

-- ── Services ──────────────────────────────────────────────────────
local HttpService  = game:GetService("HttpService")
local Selection    = game:GetService("Selection")
local RunService   = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")

-- ── Config ─────────────────────────────────────────────────────────
local SERVER       = "http://127.0.0.1:7842"
local POLL_HZ      = 2        -- polls per second
local HEARTBEAT    = 5        -- seconds between state push
local MAX_LOGS     = 50       -- log lines captured per cycle
local VERSION      = "1.0.0"

-- ── State ──────────────────────────────────────────────────────────
local active       = false
local logBuffer    = {}
local lastHeartbeat = 0

-- ── Toolbar & Widget ───────────────────────────────────────────────
local toolbar = plugin:CreateToolbar("Ollama MCP Bridge")
local toggleBtn = toolbar:CreateButton(
    "OllamaMCP",
    "Start / Stop the Ollama MCP bridge",
    "rbxassetid://7733960981",  -- generic plug icon; replace with your own
    "MCP Bridge"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right, false, false, 280, 260, 180, 160
)
local widget = plugin:CreateDockWidgetPluginGui("OllamaMCPBridge", widgetInfo)
widget.Title = "Ollama MCP  v" .. VERSION

-- ── Widget UI ─────────────────────────────────────────────────────
local root = Instance.new("Frame")
root.Size         = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = Color3.fromRGB(24, 24, 32)
root.BorderSizePixel = 0
root.Parent       = widget

local uiPad = Instance.new("UIPadding", root)
uiPad.PaddingLeft   = UDim.new(0, 10)
uiPad.PaddingRight  = UDim.new(0, 10)
uiPad.PaddingTop    = UDim.new(0, 10)
uiPad.PaddingBottom = UDim.new(0, 10)

local uiList = Instance.new("UIListLayout", root)
uiList.Padding = UDim.new(0, 6)
uiList.SortOrder = Enum.SortOrder.LayoutOrder

local function makeLabel(text, size, color, order)
    local l = Instance.new("TextLabel")
    l.Size = UDim2.new(1, 0, 0, size)
    l.BackgroundTransparency = 1
    l.TextColor3 = color
    l.Text = text
    l.TextXAlignment = Enum.TextXAlignment.Left
    l.Font = Enum.Font.Code
    l.TextSize = size
    l.LayoutOrder = order
    l.TextWrapped = true
    l.Parent = root
    return l
end

local titleLbl  = makeLabel("● OllamaMCP Bridge", 14, Color3.fromRGB(180, 140, 255), 1)
local statusLbl = makeLabel("Status: Inactive", 12, Color3.fromRGB(160, 160, 160), 2)
local cmdLbl    = makeLabel("Last cmd: —", 12, Color3.fromRGB(130, 200, 255), 3)
local logLbl    = makeLabel("", 11, Color3.fromRGB(100, 210, 130), 4)
logLbl.Size     = UDim2.new(1, 0, 0, 120)

local function setStatus(msg, color)
    statusLbl.Text       = "Status: " .. msg
    statusLbl.TextColor3 = color or Color3.fromRGB(160, 160, 160)
end

local function appendLog(msg)
    local lines = logLbl.Text ~= "" and logLbl.Text:split("\n") or {}
    table.insert(lines, os.date("%H:%M:%S") .. " " .. msg)
    if #lines > 8 then table.remove(lines, 1) end
    logLbl.Text = table.concat(lines, "\n")
end

-- ── Helpers ────────────────────────────────────────────────────────

--- Resolve a dot-separated path to an instance (e.g. "game.Workspace.Part")
local function resolvePath(path)
    local parts = path:split(".")
    local cur = game
    for i = 2, #parts do
        local child = cur:FindFirstChild(parts[i])
        if not child then
            error(("Path not found at '%s' (child '%s' missing)"):format(path, parts[i]))
        end
        cur = child
    end
    return cur
end

--- Get the full path string of an instance
local function instancePath(inst)
    if inst == game then return "game" end
    local parts = {}
    local cur = inst
    while cur and cur ~= game do
        table.insert(parts, 1, cur.Name)
        cur = cur.Parent
    end
    table.insert(parts, 1, "game")
    return table.concat(parts, ".")
end

--- Collect all scripts in the place
local function collectScripts()
    local result = {}
    local function recurse(obj)
        for _, child in ipairs(obj:GetChildren()) do
            if child:IsA("LuaSourceContainer") then
                table.insert(result, {
                    path      = instancePath(child),
                    name      = child.Name,
                    type      = child.ClassName,
                    disabled  = child:FindFirstChild("Disabled") ~= nil,
                })
            end
            recurse(child)
        end
    end
    recurse(game)
    return result
end

-- ── Command handlers ───────────────────────────────────────────────

local handlers = {}

handlers.execute = function(payload)
    local fn, err = loadstring(payload.code)
    if not fn then error(err) end
    return fn()
end

handlers.list_scripts = function(_payload)
    return collectScripts()
end

handlers.read_script = function(payload)
    local inst = resolvePath(payload.path)
    if not inst:IsA("LuaSourceContainer") then
        error(payload.path .. " is not a script")
    end
    return inst.Source
end

handlers.write_script = function(payload)
    local inst = resolvePath(payload.path)
    if not inst:IsA("LuaSourceContainer") then
        error(payload.path .. " is not a script")
    end
    inst.Source = payload.source
    return true
end

handlers.create_script = function(payload)
    local parent = resolvePath(payload.parent_path)
    local scriptType = payload.script_type or "Script"
    local inst = Instance.new(scriptType)
    inst.Name   = payload.name
    inst.Source = payload.source or ""
    inst.Parent = parent
    return instancePath(inst)
end

handlers.workspace_info = function(_payload)
    return {
        placeName   = game.Name,
        placeId     = game.PlaceId,
        gameId      = game.GameId,
        scriptCount = #collectScripts(),
        studioVersion = VERSION,
    }
end

handlers.get_selection = function(_payload)
    local sel = Selection:Get()
    local result = {}
    for _, inst in ipairs(sel) do
        table.insert(result, {
            path      = instancePath(inst),
            className = inst.ClassName,
            name      = inst.Name,
        })
    end
    return result
end

-- ── Core polling loop ─────────────────────────────────────────────

local function processCommand(command)
    local id      = command.id
    local cmdType = command.type
    local payload = command.payload or {}

    cmdLbl.Text = "Last cmd: " .. cmdType
    appendLog("→ " .. cmdType)

    local ok, result = pcall(function()
        local handler = handlers[cmdType]
        if not handler then
            error("Unknown command type: " .. tostring(cmdType))
        end
        return handler(payload)
    end)

    local body = HttpService:JSONEncode({
        commandId = id,
        result    = ok and result or nil,
        error     = (not ok) and tostring(result) or nil,
    })

    local postOk, postErr = pcall(HttpService.PostAsync, HttpService,
        SERVER .. "/result", body, Enum.HttpContentType.ApplicationJson)

    if not postOk then
        appendLog("✗ POST failed: " .. tostring(postErr))
    end
end

local function pushState()
    local body = HttpService:JSONEncode({
        scripts  = collectScripts(),
        output   = logBuffer,
        metadata = {
            placeName = game.Name,
            placeId   = game.PlaceId,
        },
    })
    logBuffer = {}
    pcall(HttpService.PostAsync, HttpService,
        SERVER .. "/state", body, Enum.HttpContentType.ApplicationJson)
end

local pollConnection

local function startBridge()
    setStatus("🟡 Connecting…", Color3.fromRGB(255, 210, 80))
    appendLog("Starting bridge to " .. SERVER)

    -- Capture print/warn output
    local oldPrint = print
    local oldWarn  = warn

    print = function(...)
        local msg = table.concat(table.pack(...), "\t")
        table.insert(logBuffer, msg)
        oldPrint(...)
    end
    warn = function(...)
        local msg = "⚠ " .. table.concat(table.pack(...), "\t")
        table.insert(logBuffer, msg)
        oldWarn(...)
    end

    pollConnection = RunService.Heartbeat:Connect(function()
        if not active then return end

        local now = tick()

        -- Periodic heartbeat / state push
        if now - lastHeartbeat > HEARTBEAT then
            lastHeartbeat = now
            task.spawn(pushState)
        end
    end)

    -- Main polling coroutine
    task.spawn(function()
        while active do
            local ok, response = pcall(function()
                return HttpService:GetAsync(SERVER .. "/poll", false)
            end)

            if ok then
                local parsed = HttpService:JSONDecode(response)
                setStatus("🟢 Connected", Color3.fromRGB(80, 220, 130))
                if parsed.hasCommand then
                    task.spawn(processCommand, parsed.command)
                end
            else
                setStatus("🔴 Disconnected — retrying…", Color3.fromRGB(240, 80, 80))
                appendLog("Poll error: " .. tostring(response))
            end

            task.wait(1 / POLL_HZ)
        end

        -- Restore original print/warn
        print = oldPrint
        warn  = oldWarn
    end)
end

local function stopBridge()
    active = false
    if pollConnection then
        pollConnection:Disconnect()
        pollConnection = nil
    end
    setStatus("Inactive", Color3.fromRGB(160, 160, 160))
    appendLog("Bridge stopped.")
end

-- ── Toggle button ─────────────────────────────────────────────────
toggleBtn.Click:Connect(function()
    active = not active
    toggleBtn:SetActive(active)
    widget.Enabled = active

    if active then
        startBridge()
    else
        stopBridge()
    end
end)

-- ── Init ──────────────────────────────────────────────────────────
appendLog("Plugin loaded v" .. VERSION)
appendLog("Click 'MCP Bridge' to start.")
