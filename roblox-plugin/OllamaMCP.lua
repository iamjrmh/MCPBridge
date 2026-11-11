--[[
    MCPBridge - Roblox Studio plugin
    Connects Roblox Studio to the local MCPBridge server, which carries commands
    from Claude Code / Ollama (or any MCP client).

    INSTALL
    1. Roblox Studio > Plugins > Plugins Folder
    2. Put this file ("OllamaMCP.lua") in that folder
    3. Restart Studio; the "MCP Bridge" button appears in the Plugins tab
    4. Click it. The window shows Connected once the MCP server is running
       (it runs while your AI coding session is open).

    If Studio asks whether this plugin may make HTTP requests to 127.0.0.1, allow it.
]]

-- ── Services ──────────────────────────────────────────────────────
local HttpService          = game:GetService("HttpService")
local Selection            = game:GetService("Selection")
local LogService           = game:GetService("LogService")
local RunService           = game:GetService("RunService")
local CollectionService    = game:GetService("CollectionService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ScriptEditorService  = game:GetService("ScriptEditorService")

-- ── Config ─────────────────────────────────────────────────────────
local SERVER          = "http://127.0.0.1:7842"
local VERSION         = "1.1.0"
local RETRY_SECONDS   = 1       -- wait after a failed poll
local IDLE_POLL_SECONDS = 0.25  -- shortest gap between two polls
local HEARTBEAT       = 5       -- seconds between output pushes
local MAX_LOG_LINES   = 400     -- output lines kept between pushes
local MAX_DEPTH       = 8       -- how deep returned tables are followed
local DEFAULT_LIMIT   = 400

-- ── State ──────────────────────────────────────────────────────────
local active     = false
local generation = 0            -- bumps on every start, so an old loop stops
local logBuffer  = {}
local captures   = {}           -- lists that collect output while code runs

-- ── Toolbar & widget ───────────────────────────────────────────────
local toolbar = plugin:CreateToolbar("MCP Bridge")
local toggleBtn = toolbar:CreateButton(
    "OllamaMCP",
    "Start / stop the MCP bridge",
    "rbxassetid://7733960981",
    "MCP Bridge"
)
toggleBtn.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right, false, false, 300, 260, 200, 160
)
local widget = plugin:CreateDockWidgetPluginGui("OllamaMCPBridge", widgetInfo)
widget.Title = "MCP Bridge  v" .. VERSION

local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = Color3.fromRGB(24, 24, 32)
root.BorderSizePixel = 0
root.Parent = widget

local uiPad = Instance.new("UIPadding")
uiPad.PaddingLeft   = UDim.new(0, 10)
uiPad.PaddingRight  = UDim.new(0, 10)
uiPad.PaddingTop    = UDim.new(0, 10)
uiPad.PaddingBottom = UDim.new(0, 10)
uiPad.Parent = root

local uiList = Instance.new("UIListLayout")
uiList.Padding = UDim.new(0, 6)
uiList.SortOrder = Enum.SortOrder.LayoutOrder
uiList.Parent = root

local function makeLabel(text, size, color, order, height)
    local l = Instance.new("TextLabel")
    l.Size = UDim2.new(1, 0, 0, height or (size + 4))
    l.BackgroundTransparency = 1
    l.TextColor3 = color
    l.Text = text
    l.TextXAlignment = Enum.TextXAlignment.Left
    l.TextYAlignment = Enum.TextYAlignment.Top
    l.Font = Enum.Font.Code
    l.TextSize = size
    l.LayoutOrder = order
    l.TextWrapped = true
    l.Parent = root
    return l
end

makeLabel("MCP Bridge", 14, Color3.fromRGB(180, 140, 255), 1)
local statusLbl = makeLabel("Status: Inactive", 12, Color3.fromRGB(160, 160, 160), 2, 46)
local cmdLbl    = makeLabel("Last command: none", 12, Color3.fromRGB(130, 200, 255), 3)
local logLbl    = makeLabel("", 11, Color3.fromRGB(100, 210, 130), 4, 120)

local GREY, YELLOW, GREEN, ORANGE, RED =
    Color3.fromRGB(160, 160, 160), Color3.fromRGB(255, 210, 80), Color3.fromRGB(80, 220, 130),
    Color3.fromRGB(255, 160, 70), Color3.fromRGB(240, 80, 80)

local function setStatus(msg, color)
    statusLbl.Text = "Status: " .. msg
    statusLbl.TextColor3 = color or GREY
end

local function appendLog(msg)
    local lines = logLbl.Text ~= "" and string.split(logLbl.Text, "\n") or {}
    table.insert(lines, os.date("%H:%M:%S") .. " " .. msg)
    while #lines > 8 do table.remove(lines, 1) end
    logLbl.Text = table.concat(lines, "\n")
end

-- ── Output capture ─────────────────────────────────────────────────
-- Everything that reaches Studio's Output window, whoever printed it.
local LOG_PREFIX = {
    [Enum.MessageType.MessageWarning] = "[warn] ",
    [Enum.MessageType.MessageError]   = "[error] ",
    [Enum.MessageType.MessageInfo]    = "[info] ",
}

LogService.MessageOut:Connect(function(message, messageType)
    local line = (LOG_PREFIX[messageType] or "") .. tostring(message)
    if active then
        table.insert(logBuffer, line)
        if #logBuffer > MAX_LOG_LINES then table.remove(logBuffer, 1) end
    end
    for _, capture in ipairs(captures) do
        if #capture < MAX_LOG_LINES then table.insert(capture, line) end
    end
end)

-- ── Paths ──────────────────────────────────────────────────────────

--- "game.Workspace.Part" for an instance.
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

local function childNamed(parent, name)
    local child = parent:FindFirstChild(name)
    if not child and parent == game then
        local ok, service = pcall(function() return game:GetService(name) end)
        if ok then child = service end
    end
    return child
end

--- The instance at a dotted path. A name that itself contains dots is found too.
local function resolvePath(path)
    if typeof(path) ~= "string" or path == "" then
        error('A path is required, for example "game.Workspace.Part"', 0)
    end
    local parts = string.split(path, ".")
    local index = 1
    if parts[1] == "game" then index = 2 end
    local cur = game
    while index <= #parts do
        local name = parts[index]
        local child = childNamed(cur, name)
        local last = index
        while not child and last < #parts do
            last += 1
            name = name .. "." .. parts[last]
            child = childNamed(cur, name)
        end
        if not child then
            error(('Nothing at "%s": "%s" has no child named "%s"'):format(path, instancePath(cur), parts[index]), 0)
        end
        cur = child
        index = last + 1
    end
    return cur
end

local function pathsOf(payload)
    local paths = {}
    if typeof(payload.paths) == "table" then
        for _, p in ipairs(payload.paths) do table.insert(paths, p) end
    end
    if typeof(payload.path) == "string" then table.insert(paths, payload.path) end
    if #paths == 0 then error("Give a path (or paths)", 0) end
    return paths
end

-- ── Values to and from JSON ────────────────────────────────────────

local function round(n)
    return math.floor(n * 10000 + 0.5) / 10000
end

--- Turns any Luau value into something JSONEncode accepts.
local function encodeValue(v, depth, seen)
    depth = depth or 0
    local t = typeof(v)
    if t == "nil" or t == "boolean" or t == "string" then return v end
    if t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
        return v
    end
    if t == "Instance" then return instancePath(v) end
    if t == "Vector3" then return { round(v.X), round(v.Y), round(v.Z) } end
    if t == "Vector2" then return { round(v.X), round(v.Y) } end
    if t == "Color3" then return "#" .. v:ToHex() end
    if t == "BrickColor" then return v.Name end
    if t == "EnumItem" then return v.Name end
    if t == "UDim" then return { round(v.Scale), v.Offset } end
    if t == "UDim2" then return { round(v.X.Scale), v.X.Offset, round(v.Y.Scale), v.Y.Offset } end
    if t == "NumberRange" then return { v.Min, v.Max } end
    if t == "CFrame" then
        local rx, ry, rz = v:ToOrientation()
        return {
            position = { round(v.X), round(v.Y), round(v.Z) },
            rotation = { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) },
        }
    end
    if t == "table" then
        if depth >= MAX_DEPTH then return "<table: too deep>" end
        seen = seen or {}
        if seen[v] then return "<table: repeats>" end
        seen[v] = true
        local count = 0
        for _ in pairs(v) do count += 1 end
        local out = {}
        if count == #v then
            for i, item in ipairs(v) do out[i] = encodeValue(item, depth + 1, seen) end
        else
            for key, item in pairs(v) do out[tostring(key)] = encodeValue(item, depth + 1, seen) end
        end
        seen[v] = nil
        return out
    end
    return tostring(v)
end

local function field(value, index, name)
    if typeof(value) ~= "table" then return nil end
    local found = value[index]
    if found == nil then found = value[name] end
    if found == nil then found = value[string.upper(name)] end
    return found
end

local function numbers(value, names)
    local out = {}
    for i, name in ipairs(names) do
        local n = tonumber(field(value, i, name))
        if n == nil then return nil end
        out[i] = n
    end
    return out
end

local function toColor3(value)
    if typeof(value) == "string" then
        return Color3.fromHex(value)
    end
    local c = numbers(value, { "r", "g", "b" })
    if not c then error("A color is \"#RRGGBB\" or [r, g, b]", 0) end
    if c[1] <= 1 and c[2] <= 1 and c[3] <= 1 and (c[1] % 1 ~= 0 or c[2] % 1 ~= 0 or c[3] % 1 ~= 0) then
        return Color3.new(c[1], c[2], c[3])
    end
    return Color3.fromRGB(c[1], c[2], c[3])
end

local function toCFrame(current, value)
    if typeof(value) ~= "table" then error("A CFrame is {position=[x,y,z], rotation=[rx,ry,rz]} or [x,y,z]", 0) end
    if #value == 12 then return CFrame.new(table.unpack(value)) end
    local position = numbers(value.position or value, { "x", "y", "z" })
    if not position then error("A CFrame needs a position [x, y, z]", 0) end
    local rotation = value.rotation and numbers(value.rotation, { "x", "y", "z" })
    if rotation then
        return CFrame.new(position[1], position[2], position[3])
            * CFrame.fromOrientation(math.rad(rotation[1]), math.rad(rotation[2]), math.rad(rotation[3]))
    end
    local keep = typeof(current) == "CFrame" and current.Rotation or CFrame.new()
    return CFrame.new(position[1], position[2], position[3]) * keep
end

--- Turns a JSON value into the type the property already holds.
local function decodeValue(current, value)
    local t = typeof(current)
    if t == "Vector3" then
        local n = numbers(value, { "x", "y", "z" })
        if not n then error("A Vector3 is [x, y, z]", 0) end
        return Vector3.new(n[1], n[2], n[3])
    elseif t == "Vector2" then
        local n = numbers(value, { "x", "y" })
        if not n then error("A Vector2 is [x, y]", 0) end
        return Vector2.new(n[1], n[2])
    elseif t == "Color3" then
        return toColor3(value)
    elseif t == "BrickColor" then
        return BrickColor.new(value)
    elseif t == "EnumItem" then
        if typeof(value) == "number" then
            for _, item in ipairs(current.EnumType:GetEnumItems()) do
                if item.Value == value then return item end
            end
        end
        local name = string.match(tostring(value), "([%w_]+)$")   -- "Enum.Material.Neon" works too
        for _, item in ipairs(current.EnumType:GetEnumItems()) do
            if item.Name == name then return item end
        end
        error(('"%s" is not a %s'):format(tostring(value), tostring(current.EnumType)), 0)
    elseif t == "UDim" then
        local n = numbers(value, { "scale", "offset" })
        if not n then error("A UDim is [scale, offset]", 0) end
        return UDim.new(n[1], n[2])
    elseif t == "UDim2" then
        if typeof(value) ~= "table" or #value ~= 4 then error("A UDim2 is [xScale, xOffset, yScale, yOffset]", 0) end
        return UDim2.new(value[1], value[2], value[3], value[4])
    elseif t == "NumberRange" then
        local n = numbers(value, { "min", "max" })
        if not n then error("A NumberRange is [min, max]", 0) end
        return NumberRange.new(n[1], n[2])
    elseif t == "CFrame" then
        return toCFrame(current, value)
    elseif t == "Instance" or t == "nil" then
        if typeof(value) == "string" and (value == "game" or string.sub(value, 1, 5) == "game.") then
            local ok, inst = pcall(resolvePath, value)
            if ok then return inst end
        end
        return value
    elseif t == "number" then
        return tonumber(value) or value
    end
    return value
end

local function setProperty(inst, name, value)
    if name == "Parent" and typeof(value) == "string" then
        inst.Parent = resolvePath(value)
        return
    end
    local ok, current = pcall(function() return inst[name] end)
    if not ok then
        error(('%s has no property "%s"'):format(inst.ClassName, name), 0)
    end
    if typeof(current) == "nil" and typeof(value) == "table" then
        -- An empty CFrame/Vector3 slot cannot be told apart; these are the usual ones.
        local three = numbers(value, { "x", "y", "z" })
        if value.position then value = toCFrame(nil, value)
        elseif three and #value == 3 then value = Vector3.new(three[1], three[2], three[3]) end
        inst[name] = value
        return
    end
    inst[name] = decodeValue(current, value)
end

local function applyChanges(inst, payload)
    local properties = payload.properties
    if typeof(properties) == "table" then
        local parent = properties.Parent
        for name, value in pairs(properties) do
            if name ~= "Parent" then setProperty(inst, name, value) end
        end
        if parent ~= nil then setProperty(inst, "Parent", parent) end
    end
    if typeof(payload.attributes) == "table" then
        for name, value in pairs(payload.attributes) do
            if typeof(value) == "table" then
                local three = numbers(value, { "x", "y", "z" })
                if three and #value == 3 then value = Vector3.new(three[1], three[2], three[3]) end
            end
            inst:SetAttribute(name, value)
        end
    end
    if typeof(payload.add_tags) == "table" then
        for _, tag in ipairs(payload.add_tags) do CollectionService:AddTag(inst, tag) end
    end
    if typeof(payload.remove_tags) == "table" then
        for _, tag in ipairs(payload.remove_tags) do CollectionService:RemoveTag(inst, tag) end
    end
end

-- Properties tried when Studio cannot list a class's own (older Studio builds).
local COMMON_PROPERTIES = {
    "Name", "ClassName", "Parent", "Archivable",
    "Anchored", "CanCollide", "CanTouch", "CanQuery", "CastShadow", "Massless", "Locked",
    "Position", "Orientation", "Size", "CFrame", "Color", "BrickColor", "Material", "Transparency", "Reflectance", "Shape",
    "PrimaryPart", "WorldPivot", "Enabled", "Disabled", "RunContext", "Value", "MaxHealth", "Health", "WalkSpeed", "JumpPower",
    "Text", "TextColor3", "TextSize", "Font", "TextScaled", "TextWrapped", "RichText", "PlaceholderText",
    "BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "AnchorPoint", "Visible", "ZIndex", "LayoutOrder",
    "Image", "ImageColor3", "ImageTransparency", "ScaleType", "ResetOnSpawn", "IgnoreGuiInset", "DisplayOrder",
    "MeshId", "TextureID", "Texture", "SoundId", "Volume", "Looped", "Playing", "PlaybackSpeed",
    "Brightness", "Range", "Angle", "Face", "Shadows", "Adornee", "Attachment0", "Attachment1", "Part0", "Part1", "C0", "C1",
    "ClockTime", "Ambient", "OutdoorAmbient", "FogEnd", "FogColor", "Gravity", "StreamingEnabled", "FieldOfView", "CameraType",
}

local function propertyNames(inst)
    local names = {}
    pcall(function()
        local reflection = game:GetService("ReflectionService")
        for _, entry in ipairs(reflection:GetPropertiesOfClass(inst.ClassName)) do
            local name = typeof(entry) == "table" and entry.Name or entry
            if typeof(name) == "string" then table.insert(names, name) end
        end
    end)
    if #names == 0 then names = COMMON_PROPERTIES end
    return names
end

-- ── Undo steps ─────────────────────────────────────────────────────

--- Runs fn as one step in Studio's undo history.
local function recorded(label, fn)
    local recording
    pcall(function() recording = ChangeHistoryService:TryBeginRecording("MCPBridge: " .. label) end)
    local results = table.pack(pcall(fn))
    if recording then
        pcall(function() ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
    else
        pcall(function() ChangeHistoryService:SetWaypoint("MCPBridge: " .. label) end)
    end
    if not results[1] then error(results[2], 0) end
    return table.unpack(results, 2, results.n)
end

-- ── Scripts ────────────────────────────────────────────────────────

local function readSource(inst)
    local ok, source = pcall(function() return ScriptEditorService:GetEditorSource(inst) end)
    if ok and typeof(source) == "string" then return source end
    return inst.Source
end

local function writeSource(inst, source)
    local ok = pcall(function()
        ScriptEditorService:UpdateSourceAsync(inst, function() return source end)
    end)
    if not ok then inst.Source = source end
end

local function scriptAt(path)
    local inst = resolvePath(path)
    if not inst:IsA("LuaSourceContainer") then
        error(path .. " is a " .. inst.ClassName .. ", not a script", 0)
    end
    return inst
end

local function newScript(className, name, source, parent, runContext)
    if className ~= "Script" and className ~= "LocalScript" and className ~= "ModuleScript" then
        error('script_type must be "Script", "LocalScript" or "ModuleScript"', 0)
    end
    local inst = Instance.new(className)
    inst.Name = name
    if runContext and className == "Script" then
        setProperty(inst, "RunContext", runContext)
    end
    inst.Parent = parent
    writeSource(inst, source or "")
    return inst
end

local function collectScripts(rootInst)
    local result = {}
    local roots = { rootInst }
    if rootInst == game then
        -- Only the places a game keeps its own code; the rest of the DataModel
        -- holds Roblox's internal scripts.
        roots = {}
        for _, name in ipairs({
            "Workspace", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage",
            "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "Chat", "Teams",
        }) do
            local ok, service = pcall(function() return game:GetService(name) end)
            if ok and service then table.insert(roots, service) end
        end
    end
    for _, from in ipairs(roots) do
        local ok, descendants = pcall(function() return from:GetDescendants() end)
        if ok then
            for _, inst in ipairs(descendants) do
                if inst:IsA("LuaSourceContainer") then
                    local okSource, source = pcall(readSource, inst)
                    local lines = 0
                    if okSource and typeof(source) == "string" and source ~= "" then
                        lines = select(2, string.gsub(source, "\n", "\n")) + 1
                    end
                    local okDisabled, disabled = pcall(function() return inst.Disabled end)
                    table.insert(result, {
                        path     = instancePath(inst),
                        name     = inst.Name,
                        type     = inst.ClassName,
                        lines    = lines,
                        disabled = okDisabled and disabled == true,
                    })
                end
            end
        end
    end
    return result
end

-- ── Command handlers ───────────────────────────────────────────────

local handlers = {}

handlers.execute = function(payload)
    if typeof(payload.code) ~= "string" then error("No code given", 0) end
    local fn, syntaxError = loadstring(payload.code, "=MCPBridge")
    if not fn then
        return { ok = false, error = "Syntax error: " .. tostring(syntaxError), output = {} }
    end

    local capture = {}
    table.insert(captures, capture)
    local results = table.pack(xpcall(fn, function(problem)
        return debug.traceback(tostring(problem), 2)
    end))
    pcall(function() ChangeHistoryService:SetWaypoint("MCPBridge: run code") end)
    task.wait(0.1)   -- output arrives a moment after the print
    local at = table.find(captures, capture)
    if at then table.remove(captures, at) end

    if not results[1] then
        return { ok = false, error = results[2], output = capture }
    end
    local values = {}
    for i = 2, results.n do
        values[i - 1] = encodeValue(results[i])
        if values[i - 1] == nil then values[i - 1] = "nil" end
    end
    return { ok = true, values = values, output = capture }
end

handlers.get_tree = function(payload)
    local rootInst = resolvePath(payload.path or "game")
    local maxDepth = math.max(1, tonumber(payload.depth) or 2)
    local limit = tonumber(payload.limit) or DEFAULT_LIMIT
    local nodes, truncated = {}, false

    local function walk(inst, depth)
        local ok, children = pcall(function() return inst:GetChildren() end)
        if not ok then return end
        for _, child in ipairs(children) do
            if #nodes >= limit then truncated = true return end
            local okInfo, name, className, count = pcall(function()
                return child.Name, child.ClassName, #child:GetChildren()
            end)
            if okInfo then
                local deeper = depth + 1 < maxDepth
                table.insert(nodes, { depth = depth, name = name, class = className, children = (not deeper and count > 0) and count or nil })
                if deeper and count > 0 then walk(child, depth + 1) end
            end
        end
    end

    walk(rootInst, 0)
    return { root = instancePath(rootInst) .. " [" .. rootInst.ClassName .. "]", nodes = nodes, truncated = truncated }
end

handlers.find = function(payload)
    local rootInst = resolvePath(payload.root or "game")
    local limit = tonumber(payload.limit) or 200
    local wantName = typeof(payload.name) == "string" and payload.name ~= "" and string.lower(payload.name) or nil
    local wantClass = typeof(payload.class_name) == "string" and payload.class_name ~= "" and payload.class_name or nil
    if not wantName and not wantClass then error("Give a name and/or a class_name to search for", 0) end

    local items, truncated = {}, false
    local roots = { rootInst }
    if rootInst == game then roots = game:GetChildren() end
    for _, from in ipairs(roots) do
        local ok, descendants = pcall(function() return from:GetDescendants() end)
        if ok then
            if rootInst == game then table.insert(descendants, 1, from) end
            for _, inst in ipairs(descendants) do
                local okMatch, matches = pcall(function()
                    if wantClass and not inst:IsA(wantClass) then return false end
                    if wantName and not string.find(string.lower(inst.Name), wantName, 1, true) then return false end
                    return true
                end)
                if okMatch and matches then
                    if #items >= limit then truncated = true break end
                    table.insert(items, { path = instancePath(inst), class = inst.ClassName })
                end
            end
        end
        if truncated then break end
    end
    return { items = items, truncated = truncated }
end

handlers.get_properties = function(payload)
    local inst = resolvePath(payload.path)
    local wanted = typeof(payload.properties) == "table" and #payload.properties > 0 and payload.properties or propertyNames(inst)
    local properties = {}
    for _, name in ipairs(wanted) do
        local ok, value = pcall(function() return inst[name] end)
        if ok and typeof(value) ~= "RBXScriptSignal" and typeof(value) ~= "function" then
            local encoded = encodeValue(value)
            if encoded ~= nil then properties[name] = encoded end
        end
    end
    local attributes = {}
    for name, value in pairs(inst:GetAttributes()) do attributes[name] = encodeValue(value) end
    return {
        path       = instancePath(inst),
        class      = inst.ClassName,
        properties = properties,
        attributes = attributes,
        tags       = CollectionService:GetTags(inst),
        children   = #inst:GetChildren(),
    }
end

handlers.set_properties = function(payload)
    local changed = {}
    recorded("set properties", function()
        for _, path in ipairs(pathsOf(payload)) do
            local inst = resolvePath(path)
            applyChanges(inst, payload)
            table.insert(changed, instancePath(inst))
        end
    end)
    return changed
end

local function build(spec, parent)
    if typeof(spec.class_name) ~= "string" then error("class_name is required", 0) end
    local ok, inst = pcall(Instance.new, spec.class_name)
    if not ok then error(('"%s" is not a class that can be created'):format(spec.class_name), 0) end
    if typeof(spec.name) == "string" then inst.Name = spec.name end
    local okApply, problem = pcall(applyChanges, inst, spec)
    if not okApply then
        inst:Destroy()
        error(problem, 0)
    end
    if typeof(spec.children) == "table" then
        for _, childSpec in ipairs(spec.children) do build(childSpec, inst) end
    end
    if inst.Parent == nil then inst.Parent = parent end
    return inst
end

handlers.create_instance = function(payload)
    local parent = resolvePath(payload.parent_path)
    local inst = recorded("create " .. tostring(payload.class_name), function()
        return build(payload, parent)
    end)
    return instancePath(inst)
end

handlers.delete_instance = function(payload)
    local deleted = {}
    recorded("delete", function()
        for _, path in ipairs(pathsOf(payload)) do
            local inst = resolvePath(path)
            if inst == game or inst.Parent == game then error("Refusing to delete " .. path, 0) end
            table.insert(deleted, instancePath(inst))
            inst.Parent = nil   -- not Destroy: undo has to be able to bring it back
        end
    end)
    return deleted
end

handlers.clone_instance = function(payload)
    local source = resolvePath(payload.path)
    local parent = payload.new_parent_path and resolvePath(payload.new_parent_path) or source.Parent
    local copy = recorded("clone", function()
        local wasArchivable = source.Archivable
        source.Archivable = true
        local made = source:Clone()
        source.Archivable = wasArchivable
        if not made then error("Could not clone " .. payload.path, 0) end
        if typeof(payload.name) == "string" then made.Name = payload.name end
        applyChanges(made, payload)
        if made.Parent == nil then made.Parent = parent end
        return made
    end)
    return instancePath(copy)
end

handlers.move_instance = function(payload)
    local inst = resolvePath(payload.path)
    recorded("move", function()
        if typeof(payload.name) == "string" then inst.Name = payload.name end
        if typeof(payload.new_parent_path) == "string" then inst.Parent = resolvePath(payload.new_parent_path) end
    end)
    return instancePath(inst)
end

handlers.insert_asset = function(payload)
    local id = tonumber(string.match(tostring(payload.asset_id), "%d+"))
    if not id then error("asset_id must be a number", 0) end
    local parent = resolvePath(payload.parent_path or "game.Workspace")
    local inserted = {}
    recorded("insert asset " .. id, function()
        local objects = game:GetObjects("rbxassetid://" .. id)
        for _, object in ipairs(objects) do
            object.Parent = parent
            table.insert(inserted, instancePath(object))
        end
    end)
    if #inserted == 0 then error("Asset " .. id .. " contained nothing that could be inserted", 0) end
    return inserted
end

handlers.list_scripts = function(payload)
    return collectScripts(payload.root and resolvePath(payload.root) or game)
end

handlers.read_script = function(payload)
    return readSource(scriptAt(payload.path))
end

handlers.write_script = function(payload)
    if typeof(payload.source) ~= "string" then error("No source given", 0) end
    local ok, inst = pcall(scriptAt, payload.path)
    if not ok then
        local exists = pcall(resolvePath, payload.path)
        if exists or not payload.create then error(inst, 0) end
        -- Not there yet: create it under the parent the path names.
        local parentPath, name = string.match(payload.path, "^(.*)%.([^%.]+)$")
        if not parentPath then error(inst, 0) end
        local parent = resolvePath(parentPath)
        local made = recorded("create script", function()
            return newScript(payload.script_type or "Script", name, payload.source, parent)
        end)
        return instancePath(made) .. " (created)"
    end
    recorded("write script", function() writeSource(inst, payload.source) end)
    return instancePath(inst)
end

handlers.edit_script = function(payload)
    local inst = scriptAt(payload.path)
    local old, new = payload.old_text, payload.new_text
    if typeof(old) ~= "string" or old == "" or typeof(new) ~= "string" then error("old_text and new_text are required", 0) end
    local source = readSource(inst)
    local pieces, count, from = {}, 0, 1
    while true do
        local first, last = string.find(source, old, from, true)
        if not first then break end
        table.insert(pieces, string.sub(source, from, first - 1))
        table.insert(pieces, new)
        count += 1
        from = last + 1
    end
    if count == 0 then error("old_text was not found in " .. payload.path .. ". Read the script and copy the text exactly.", 0) end
    if count > 1 and not payload.replace_all then
        error(("old_text appears %d times in %s. Include more surrounding text, or pass replace_all."):format(count, payload.path), 0)
    end
    table.insert(pieces, string.sub(source, from))
    recorded("edit script", function() writeSource(inst, table.concat(pieces)) end)
    return { count = count }
end

handlers.create_script = function(payload)
    local parent = resolvePath(payload.parent_path)
    if typeof(payload.name) ~= "string" or payload.name == "" then error("name is required", 0) end
    local inst = recorded("create script", function()
        return newScript(payload.script_type or "Script", payload.name, payload.source, parent, payload.run_context)
    end)
    return instancePath(inst)
end

handlers.workspace_info = function(_payload)
    local okCount, instanceCount = pcall(function() return #workspace:GetDescendants() end)
    return {
        placeName          = game.Name,
        placeId            = game.PlaceId,
        gameId             = game.GameId,
        scriptCount        = #collectScripts(game),
        workspaceInstances = okCount and instanceCount or nil,
        playtestRunning    = RunService:IsRunning(),
        pluginVersion      = VERSION,
    }
end

handlers.get_selection = function(_payload)
    local result = {}
    for _, inst in ipairs(Selection:Get()) do
        table.insert(result, { path = instancePath(inst), className = inst.ClassName, name = inst.Name })
    end
    return result
end

handlers.set_selection = function(payload)
    local list, paths = {}, {}
    for _, path in ipairs(typeof(payload.paths) == "table" and payload.paths or {}) do
        local inst = resolvePath(path)
        table.insert(list, inst)
        table.insert(paths, instancePath(inst))
    end
    Selection:Set(list)
    return paths
end

handlers.undo = function(payload)
    local done = 0
    for _ = 1, math.max(1, tonumber(payload.steps) or 1) do
        local ok, can = pcall(function() return ChangeHistoryService:GetCanUndo() end)
        if not ok or not can then break end
        ChangeHistoryService:Undo()
        done += 1
        task.wait()
    end
    return done
end

handlers.redo = function(payload)
    local done = 0
    for _ = 1, math.max(1, tonumber(payload.steps) or 1) do
        local ok, can = pcall(function() return ChangeHistoryService:GetCanRedo() end)
        if not ok or not can then break end
        ChangeHistoryService:Redo()
        done += 1
        task.wait()
    end
    return done
end

-- ── Talking to the server ──────────────────────────────────────────

local function post(route, bodyTable)
    local okEncode, body = pcall(function() return HttpService:JSONEncode(bodyTable) end)
    if not okEncode then return false, "could not encode: " .. tostring(body) end
    return pcall(function()
        return HttpService:PostAsync(SERVER .. route, body, Enum.HttpContentType.ApplicationJson)
    end)
end

local function processCommand(command)
    local cmdType = tostring(command.type)
    local payload = typeof(command.payload) == "table" and command.payload or {}

    cmdLbl.Text = "Last command: " .. cmdType
    appendLog("> " .. cmdType)

    local ok, result = pcall(function()
        local handler = handlers[cmdType]
        if not handler then
            error(('This plugin (v%s) does not know "%s". Replace OllamaMCP.lua in the plugins folder with the newest one and restart Studio.'):format(VERSION, cmdType), 0)
        end
        return handler(payload)
    end)

    local answer = { commandId = command.id }
    if ok then
        answer.result = encodeValue(result)
    else
        answer.error = tostring(result)
        appendLog("x " .. string.sub(tostring(result), 1, 80))
    end

    local sent, problem = post("/result", answer)
    if not sent then
        -- The result itself could not be sent (too large, or not text): say so instead of leaving the tool waiting.
        appendLog("x result not sent")
        post("/result", { commandId = command.id, error = "The result could not be sent back: " .. string.sub(tostring(problem), 1, 300) })
    end
end

local function pushState()
    local lines = logBuffer
    logBuffer = {}
    post("/state", {
        output   = lines,
        metadata = { placeName = game.Name, placeId = game.PlaceId, playtestRunning = RunService:IsRunning() },
    })
end

local function startBridge()
    generation += 1
    local mine = generation
    setStatus("Connecting...", YELLOW)
    appendLog("Connecting to " .. SERVER)

    task.spawn(function()
        local known = false       -- did we already look at who answered
        while active and generation == mine do
            local asked = os.clock()
            local ok, response = pcall(function()
                return HttpService:GetAsync(SERVER .. "/poll?v=" .. VERSION, true)
            end)
            if not (active and generation == mine) then break end
            -- A current server holds an idle poll open; an older one answers at once.
            if ok and os.clock() - asked < IDLE_POLL_SECONDS then task.wait(IDLE_POLL_SECONDS) end

            if ok then
                local decoded, parsed = pcall(function() return HttpService:JSONDecode(response) end)
                if not known then
                    known = true
                    -- An old server left running by a closed session answers polls but no agent is behind it.
                    local okHealth, health = pcall(function()
                        return HttpService:JSONDecode(HttpService:GetAsync(SERVER .. "/health", true))
                    end)
                    if okHealth and typeof(health) == "table" and health.version == nil then
                        setStatus("Connected to an OLD MCPBridge server. Update mcp-server/index.js, then close leftover \"node\" processes.", ORANGE)
                    else
                        setStatus("Connected", GREEN)
                        appendLog("Connected")
                    end
                end
                if decoded and typeof(parsed) == "table" and parsed.hasCommand and typeof(parsed.command) == "table" then
                    task.spawn(processCommand, parsed.command)
                end
            else
                if known or statusLbl.TextColor3 ~= RED then
                    appendLog("Server not reachable")
                end
                known = false
                local reason = tostring(response)
                if string.find(reason, "Http requests are not enabled", 1, true) then
                    setStatus("Blocked: turn on \"Allow HTTP Requests\" in Game Settings > Security.", RED)
                else
                    setStatus("Waiting for the MCP server. It runs while your AI coding session is open.", RED)
                end
                task.wait(RETRY_SECONDS)
            end
        end
    end)

    task.spawn(function()
        while active and generation == mine do
            task.wait(HEARTBEAT)
            if active and generation == mine and #logBuffer > 0 then pushState() end
        end
    end)
end

local function stopBridge()
    generation += 1
    setStatus("Inactive", GREY)
    appendLog("Bridge stopped")
end

local function setActive(on)
    active = on
    toggleBtn:SetActive(on)
    widget.Enabled = on
    if on then startBridge() else stopBridge() end
    pcall(function() plugin:SetSetting("MCPBridgeActive", on) end)
end

toggleBtn.Click:Connect(function()
    setActive(not active)
end)

plugin.Unloading:Connect(function()
    active = false
    generation += 1
end)

-- ── Init ──────────────────────────────────────────────────────────
appendLog("Plugin loaded v" .. VERSION)
local okSetting, wasActive = pcall(function() return plugin:GetSetting("MCPBridgeActive") end)
if okSetting and wasActive == true then
    setActive(true)   -- stays on across Studio restarts until switched off
else
    appendLog("Click \"MCP Bridge\" to start")
end
