const fs = require('fs');
const path = require('path');
const { LuaFactory } = require('wasmoon');

async function main() {
    const factory = new LuaFactory();
    const lua = await factory.createEngine();

    // Set up helper to receive output from Lua print calls
    lua.global.set('print_js', (msg) => {
        console.log(msg);
    });

    const setupMocksLua = `
        -- Global State Mocks
        db_store = {}
        db_handlers = {}
        ct_entries = {}
        oob_handlers = {}
        options_store = {}
        calls = {}
        distances = {}

        function recordCall(name, ...)
            if not calls[name] then calls[name] = {} end
            table.insert(calls[name], {...})
        end

        local function splitPath(path)
            local t = {}
            if path == nil then return t end
            for s in string.gmatch(path, "([^%.]+)") do
                table.insert(t, s)
            end
            return t
        end

        -- Databasenode Mock
        databasenode = {}
        
        local methods = {}
        
        function methods.getPath(self)
            return self.path
        end
        
        function methods.getName(self)
            local parts = splitPath(self.path)
            return parts[#parts] or ""
        end
        
        function methods.getParent(self)
            if self == nil then
                print_js("DEBUG: getParent self is nil! Traceback:")
                print_js(debug.traceback())
                return nil
            end
            local parts = splitPath(self.path)
            if #parts <= 1 then return nil end
            table.remove(parts)
            local parentPath = table.concat(parts, ".")
            return databasenode.new(parentPath)
        end
        
        function methods.getChild(self, relPath)
            if relPath == nil then
                return nil
            end
            if relPath == "." then
                return self
            elseif relPath == ".." then
                return methods.getParent(self)
            elseif relPath == "..." then
                local p = methods.getParent(self)
                return p and methods.getParent(p) or nil
            else
                local childPath = self.path .. "." .. relPath
                return databasenode.new(childPath)
            end
        end
        
        function methods.delete(self)
            db_store[self.path] = nil
            local prefix = self.path .. "."
            for k, v in pairs(db_store) do
                if k == self.path or string.sub(k, 1, string.len(prefix)) == prefix then
                    db_store[k] = nil
                end
            end
            local parent = methods.getParent(self)
            if parent then
                triggerHandlers(parent:getPath(), "onChildDeleted", self)
            end
        end
        
        databasenode.__index = function(self, key)
            local val = methods[key]
            if type(val) == "function" then
                return function(...)
                    local args = {...}
                    if args[1] == self then
                        return val(self, select(2, ...))
                    else
                        return val(self, ...)
                    end
                end
            end
            return val
        end

        databasenode.__eq = function(a, b)
            if type(a) ~= "table" or type(b) ~= "table" then return false end
            return a.path == b.path
        end

        function databasenode.new(path)
            local self = setmetatable({}, databasenode)
            self.path = path
            return self
        end

        -- DB Mock
        DB = {}

        function DB.getPath(pattern)
            return pattern
        end

        function DB.findNode(path)
            if not path or path == "" then return nil end
            return databasenode.new(path)
        end

        function DB.getValue(node, field, default)
            local path
            local def
            if type(node) == "string" then
                path = node
                if default ~= nil then
                    if field and field ~= "" then path = path .. "." .. field end
                    def = default
                else
                    def = field
                end
            elseif type(node) == "table" and node.path then
                path = node.path
                if field and field ~= "" then path = path .. "." .. field end
                def = default
            else
                return default or field
            end
            
            if db_store[path] ~= nil then
                return db_store[path]
            end
            return def
        end

        function DB.setValue(node, field, valueType, value)
            local path
            local val
            if type(node) == "table" and node.path then
                path = node.path
                if value ~= nil then
                    path = path .. "." .. field
                    val = value
                else
                    val = field
                end
            else
                path = node
                if value ~= nil then
                    path = path .. "." .. field
                    val = value
                elseif valueType ~= nil then
                    val = valueType
                else
                    val = field
                end
            end
            
            local oldVal = db_store[path]
            db_store[path] = val
            
            if oldVal ~= val then
                local nodeObj = databasenode.new(path)
                triggerHandlers(path, "onUpdate", nodeObj)
                triggerHandlers(path, "onChildUpdate", nodeObj)
            end
        end

        function DB.getChildren(node, path)
            local parentPath
            if type(node) == "string" then
                parentPath = node
                if path and path ~= "" then parentPath = parentPath .. "." .. path end
            else
                parentPath = node.path
                if path and path ~= "" then parentPath = parentPath .. "." .. path end
            end
            
            local children = {}
            local prefix = parentPath .. "."
            local prefixLen = string.len(prefix)
            for k, v in pairs(db_store) do
                if string.sub(k, 1, prefixLen) == prefix then
                    local sub = string.sub(k, prefixLen + 1)
                    local dotIdx = string.find(sub, "%.")
                    local childName = dotIdx and string.sub(sub, 1, dotIdx - 1) or sub
                    local childPath = prefix .. childName
                    if not children[childName] then
                        children[childName] = databasenode.new(childPath)
                    end
                end
            end
            return children
        end

        function DB.addHandler(pathPattern, eventName, handlerFunc)
            if not db_handlers[pathPattern] then
                db_handlers[pathPattern] = {}
            end
            if not db_handlers[pathPattern][eventName] then
                db_handlers[pathPattern][eventName] = {}
            end
            table.insert(db_handlers[pathPattern][eventName], handlerFunc)
        end

        function DB.removeHandler(pathPattern, eventName, handlerFunc)
            if not db_handlers[pathPattern] or not db_handlers[pathPattern][eventName] then
                return
            end
            local list = db_handlers[pathPattern][eventName]
            for i = #list, 1, -1 do
                if list[i] == handlerFunc then
                    table.remove(list, i)
                end
            end
        end

        function triggerHandlers(path, eventName, argNode)
            for pattern, events in pairs(db_handlers) do
                if events[eventName] then
                    local luaPattern = string.gsub(pattern, "%.", "%%.")
                    luaPattern = string.gsub(luaPattern, "%*", "[^%%.]+")
                    luaPattern = "^" .. luaPattern .. "$"
                    
                    if eventName == "onChildUpdate" then
                        local parentPath = argNode:getParent():getPath()
                        if string.match(parentPath, luaPattern) then
                            for _, func in ipairs(events[eventName]) do
                                func(argNode:getParent(), argNode)
                            end
                        end
                    elseif eventName == "onChildDeleted" then
                        local parentPath = argNode:getParent():getPath()
                        if string.match(parentPath, luaPattern) then
                            for _, func in ipairs(events[eventName]) do
                                func(argNode)
                            end
                        end
                    elseif eventName == "onUpdate" then
                        if string.match(path, luaPattern) then
                            for _, func in ipairs(events[eventName]) do
                                func(argNode)
                            end
                        end
                    end
                end
            end
        end

        -- Other Global API Mocks
        ActorManager = {}
        function ActorManager.resolveActor(node)
            return { node = node }
        end
        function ActorManager.getFaction(actor)
            if not actor or not actor.node then
                print_js("DEBUG: getFaction actor or node is nil!")
                return ""
            end
            local path = actor.node:getPath()
            local val = DB.getValue(path .. ".friendfoe", "")
            print_js("DEBUG: getFaction for " .. tostring(path) .. " returned " .. tostring(val))
            return val
        end

        ActorHealthManager = {
            STATUS_UNCONSCIOUS = "unconscious"
        }
        function ActorHealthManager.isDyingOrDead(rActor)
            if not rActor or not rActor.node then return false end
            local path = rActor.node:getPath()
            local status = DB.getValue(path .. ".status", "")
            return status == "dead" or status == "dying"
        end
        function ActorHealthManager.getHealthStatus(rActor)
            if not rActor or not rActor.node then return "" end
            local path = rActor.node:getPath()
            return DB.getValue(path .. ".status", "")
        end

        EffectManager = {}
        function EffectManager.parseEffect(sLabel)
            local t = {}
            if sLabel == nil then return t end
            for s in string.gmatch(sLabel, "([^;]+)") do
                local trimmed = string.gsub(s, "^%s*(.-)%s*$", "%1")
                table.insert(t, trimmed)
            end
            return t
        end
        function EffectManager.isTargetedEffect(nodeEffect)
            local path = nodeEffect:getPath()
            return DB.getValue(path .. ".targets", "") ~= ""
        end
        function EffectManager.getEffectTargets(nodeEffect, bForce)
            local path = nodeEffect:getPath()
            local targetsStr = DB.getValue(path .. ".targets", "")
            local t = {}
            for s in string.gmatch(targetsStr, "([^,]+)") do
                table.insert(t, s)
            end
            return t
        end
        function EffectManager.rebuildParsedEffect(aEffectComps)
            return table.concat(aEffectComps, "; ")
        end
        function EffectManager.notifyExpire(nodeEffect, target, bSilent)
            recordCall("EffectManager.notifyExpire", nodeEffect:getPath(), target, bSilent)
            nodeEffect:delete()
        end
        function EffectManager.notifyApply(rEffect, targetPath)
            recordCall("EffectManager.notifyApply", rEffect, targetPath)
            local nodeCTEntry = DB.findNode(targetPath)
            if nodeCTEntry then
                EffectManager.addEffect("", "", nodeCTEntry, rEffect, false)
            end
        end
        function EffectManager.addEffect(user, identity, nodeCTEntry, rEffect, bSilent)
            recordCall("EffectManager.addEffect", user, identity, nodeCTEntry:getPath(), rEffect, bSilent)
            
            local effectsPath = nodeCTEntry:getPath() .. ".effects"
            local id = "id-" .. string.format("%05d", math.random(1, 100000))
            local effectNodePath = effectsPath .. "." .. id
            
            DB.setValue(effectNodePath .. ".label", "string", rEffect.sLabel or rEffect.sName)
            DB.setValue(effectNodePath .. ".isactive", "number", 1)
            DB.setValue(effectNodePath .. ".source_name", "string", rEffect.sSource or "")
            DB.setValue(effectNodePath .. ".duration", "number", rEffect.nDuration or 0)
            DB.setValue(effectNodePath .. ".isgmonly", "number", rEffect.nGMOnly or 0)
            DB.setValue(effectNodePath .. ".init", "number", rEffect.nInit or 0)
            DB.setValue(effectNodePath .. ".unit", "string", rEffect.sUnits or "")
        end

        OptionsManager = {}
        function OptionsManager.registerOption2(name, bForce, header, label, entry, table_values)
            recordCall("OptionsManager.registerOption2", name, bForce, header, label, entry, table_values)
        end
        function OptionsManager.getOption(name)
            return options_store[name] or "off"
        end

        Comm = {}
        function Comm.deliverOOBMessage(msgOOB, recipient)
            recordCall("Comm.deliverOOBMessage", msgOOB, recipient)
            local handler = oob_handlers[msgOOB.type]
            if handler then
                handler(msgOOB)
            end
        end

        CombatManager = {
            CT_LIST = "combattracker.list"
        }
        function CombatManager.getSortedCombatantList()
            local t = {}
            for _, path in ipairs(ct_entries) do
                table.insert(t, databasenode.new(path))
            end
            return t
        end
        function CombatManager.getCTFromToken(tokenMap)
            if not tokenMap or not tokenMap.path then return nil end
            return databasenode.new(tokenMap.path)
        end
        function CombatManager.getTokenFromCT(nodeCT)
            if not nodeCT then return nil end
            return { path = nodeCT:getPath() }
        end

        OOBManager = {}
        function OOBManager.registerOOBMsgHandler(msgType, handlerFunc)
            oob_handlers[msgType] = handlerFunc
        end

        Session = {
            IsHost = true
        }

        User = {}
        function User.getUsername() return "TestGM" end
        function User.getIdentityLabel() return "GM" end

        Interface = {}
        function Interface.getString(key) return "STRING_" .. key end
        Interface.onWindowOpened = function() end

        Token = {}
        function Token.getDistanceBetween(tokenSource, tokenTarget)
            local p1 = tokenSource.path
            local p2 = tokenTarget.path
            local key = p1 .. "-" .. p2
            local keyAlt = p2 .. "-" .. p1
            return distances[key] or distances[keyAlt] or 9999
        end
        Token.onMove = function() end

        ChatManager = {}
        function ChatManager.SystemMessage(msg)
            recordCall("ChatManager.SystemMessage", msg)
        end

        Debug = {}
        function Debug.console(...)
            recordCall("Debug.console", ...)
        end
        function Debug.chat(...)
            recordCall("Debug.chat", ...)
        end

        ImageManager = {}
        function ImageManager.getImageControl(tokenMap)
            return nil, "imagewindow"
        end

        EffectManager35E = {
            checkConditional = function(rActor, nodeEffect, aConditions, rTarget, aIgnore)
                recordCall("EffectManager35E.checkConditional", rActor, nodeEffect, aConditions, rTarget, aIgnore)
                return true
            end
        }
        original_checkConditional = EffectManager35E.checkConditional
    `;

    // Load setup Lua
    await lua.doString(setupMocksLua);

    // Read the extension script
    const extensionScriptPath = path.join(__dirname, '../scripts/manager_effect_aura.lua');
    const extensionScript = fs.readFileSync(extensionScriptPath, 'utf8');

    // Run the extension script inside the engine
    await lua.doString(extensionScript);

    const testExecutionLua = `
        test_failures = 0

        function assert_eq(actual, expected, message)
            if actual ~= expected then
                test_failures = test_failures + 1
                print_js("FAIL: " .. (message or "") .. " | Expected: " .. tostring(expected) .. " | Got: " .. tostring(actual))
            else
                -- print_js("PASS: " .. (message or "assertion"))
            end
        end

        function assert_not_nil(val, message)
            if val == nil then
                test_failures = test_failures + 1
                print_js("FAIL: " .. (message or "") .. " | Expected non-nil value")
            end
        end

        function run_test(name, fn)
            print_js("Running test: " .. name)
            local status, err = pcall(fn)
            if not status then
                test_failures = test_failures + 1
                print_js("ERROR in " .. name .. ": " .. tostring(err))
            end
        end

        -- RESET helper
        function resetState()
            db_store = {}
            db_handlers = {}
            ct_entries = {}
            oob_handlers = {}
            options_store = {}
            calls = {}
            distances = {}
            Session.IsHost = true
            if EffectManager35E and original_checkConditional then
                EffectManager35E.checkConditional = original_checkConditional
            end
        end

        function print_db()
            for k, v in pairs(db_store) do
                print_js("DB_STORE: " .. k .. " = " .. tostring(v))
            end
        end

        -- 1. Test onInit
        run_test("onInit Registers Option and Handlers", function()
            resetState()
            onInit()

            -- Verify option is registered
            assert_not_nil(calls["OptionsManager.registerOption2"], "OptionsManager.registerOption2 called")
            assert_eq(calls["OptionsManager.registerOption2"][1][1], "AURASILENT", "Registered AURASILENT option")

            -- Verify OOB Message Handlers are registered
            assert_eq(oob_handlers["aurasontokenmove"], handleTokenMovement, "Registered handleTokenMovement handler")
            assert_eq(oob_handlers["applyeffsilent"], handleApplyEffectSilent, "Registered handleApplyEffectSilent handler")
            assert_eq(oob_handlers["expireeffsilent"], handleExpireEffectSilent, "Registered handleExpireEffectSilent handler")

            -- Verify DB handlers are registered (Since Session.IsHost is true)
            assert_not_nil(db_handlers["combattracker.list.*.effects.*"], "onChildUpdate handler registered")
            assert_not_nil(db_handlers["combattracker.list.*.effects"], "onChildDeleted handler registered")
            assert_not_nil(db_handlers["combattracker.list.*.status"], "onUpdate handler registered")
        end)

        -- 2. Test Basic Aura Application (foe, distance <= range)
        run_test("Basic Aura Application (foe relationship)", function()
            resetState()
            onInit()

            -- Set up combatants
            ct_entries = { "combattracker.list.id-00001", "combattracker.list.id-00002" }
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")

            -- Set distance
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 10

            -- Add active Aura effect to combatant 1
            local auraEffectPath = "combattracker.list.id-00001.effects.id-00010"
            DB.setValue(auraEffectPath .. ".label", "string", "AURA: 15 foe; ATK: 2")
            DB.setValue(auraEffectPath .. ".isactive", "number", 1)

            -- Manually trigger updateAuras
            updateAuras(DB.findNode("combattracker.list.id-00001"))

            -- Check that combatant 2 received the aura effect
            local children2 = DB.getChildren("combattracker.list.id-00002", "effects")
            local found = false
            local effectLabel = ""
            for _, node in pairs(children2) do
                local label = DB.getValue(node, "label", "")
                if string.find(label, "FROMAURA") then
                    found = true
                    effectLabel = label
                    assert_eq(DB.getValue(node, "source_name", ""), "combattracker.list.id-00001", "Effect source is node 1")
                end
            end
            assert_eq(effectLabel, "FROMAURA;ATK: 2;", "Applied effect label is correct")
        end)

        -- 3. Test Aura Relationship Filtering (friend vs foe)
        run_test("Aura Relationship Filtering (friend aura doesn't apply to foe)", function()
            resetState()
            onInit()

            ct_entries = { "combattracker.list.id-00001", "combattracker.list.id-00002" }
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 10

            local auraEffectPath = "combattracker.list.id-00001.effects.id-00010"
            DB.setValue(auraEffectPath .. ".label", "string", "AURA: 15 friend; DEF: 2")
            DB.setValue(auraEffectPath .. ".isactive", "number", 1)

            updateAuras(DB.findNode("combattracker.list.id-00001"))

            local children2 = DB.getChildren("combattracker.list.id-00002", "effects")
            local found = false
            for _, node in pairs(children2) do
                local label = DB.getValue(node, "label", "")
                if string.find(label, "FROMAURA") then
                    found = true
                end
            end
            assert_eq(found, false, "Combatant 2 (foe) should NOT receive friend aura")
        end)

        -- 4. Test Aura Expiration when moving out of range
        run_test("Aura Expiration when moving out of range", function()
            resetState()
            onInit()

            ct_entries = { "combattracker.list.id-00001", "combattracker.list.id-00002" }
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")
            
            -- Inside range initially
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 10

            local auraEffectPath = "combattracker.list.id-00001.effects.id-00010"
            DB.setValue(auraEffectPath .. ".label", "string", "AURA: 15 foe; ATK: 2")
            DB.setValue(auraEffectPath .. ".isactive", "number", 1)

            updateAuras(DB.findNode("combattracker.list.id-00001"))

            -- Verify it applied first
            local children2 = DB.getChildren("combattracker.list.id-00002", "effects")
            local effectNode = nil
            for _, node in pairs(children2) do
                local label = DB.getValue(node, "label", "")
                if string.find(label, "FROMAURA") then
                    effectNode = node
                end
            end
            assert_not_nil(effectNode, "Aura effect should exist initially")

            -- Move out of range
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 20
            updateAuras(DB.findNode("combattracker.list.id-00001"))

            -- Verify effect node is now deleted / inactive
            local activeVal = DB.getValue(effectNode, "isactive", 0)
            assert_eq(activeVal, 0, "Aura effect should be expired/inactive")
        end)

        -- 5. Test DB Handlers (Automatic application on effect added)
        run_test("Automatic application via DB Handlers", function()
            resetState()
            onInit()

            ct_entries = { "combattracker.list.id-00001", "combattracker.list.id-00002" }
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 10

            -- Trigger effect label set via DB.setValue to verify handlers trigger updateAuras
            local auraEffectPath = "combattracker.list.id-00001.effects.id-00010"
            DB.setValue(auraEffectPath .. ".label", "string", "AURA: 15 foe; ATK: 2")
            DB.setValue(auraEffectPath .. ".isactive", "number", 1)

            -- Verify child updated handler automatically added effect to combatant 2
            local children2 = DB.getChildren("combattracker.list.id-00002", "effects")
            local found = false
            for _, node in pairs(children2) do
                local label = DB.getValue(node, "label", "")
                if string.find(label, "FROMAURA;ATK: 2") then
                    found = true
                end
            end
            assert_eq(found, true, "DB child updated handler should trigger aura application automatically")
        end)

        -- 6. Test Silent Notification handling
        run_test("Silent notification option (AURASILENT)", function()
            resetState()
            onInit()

            options_store["AURASILENT"] = "foe"

            ct_entries = { "combattracker.list.id-00001", "combattracker.list.id-00002" }
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")
            distances["combattracker.list.id-00001-combattracker.list.id-00002"] = 10

            -- We expect OOB delivery because silent option matches 'foe' (which matches the aura type 'foe')
            local auraEffectPath = "combattracker.list.id-00001.effects.id-00010"
            DB.setValue(auraEffectPath .. ".label", "string", "AURA: 15 foe; ATK: 2")
            DB.setValue(auraEffectPath .. ".isactive", "number", 1)

            updateAuras(DB.findNode("combattracker.list.id-00001"))

            -- Check that deliverOOBMessage was called with applyeffsilent
            local delivered = false
            for _, c in ipairs(calls["Comm.deliverOOBMessage"] or {}) do
                local msg = c[1]
                if msg.type == "applyeffsilent" then
                    delivered = true
                    assert_eq(msg.sTargetNode, "combattracker.list.id-00002", "OOB target is correct")
                end
            end
            assert_eq(delivered, true, "OOB applyeffsilent should be delivered when silent is enabled")
        end)

        -- 7. Test CheckConditional Proxy Integration
        run_test("checkConditional proxy integration with faction check", function()
            resetState()
            onInit()

            -- We check that customCheckConditional is registered on EffectManager35E
            -- Let's define the parameters
            local rActor = { node = databasenode.new("combattracker.list.id-00001") }
            local rTarget = { node = databasenode.new("combattracker.list.id-00002") }
            
            DB.setValue("combattracker.list.id-00001.friendfoe", "friend")
            DB.setValue("combattracker.list.id-00002.friendfoe", "friend") -- same faction
            
            local nodeEffect = databasenode.new("combattracker.list.id-00001.effects.id-00020")
            DB.setValue(nodeEffect:getPath() .. ".source_name", "string", "combattracker.list.id-00002")

            -- Call the proxy on EffectManager35E
            local conds = { "faction(friend)" }
            local result = EffectManager35E.checkConditional(rActor, nodeEffect, conds, rTarget)
            
            assert_eq(result, true, "Faction friend check should succeed")

            -- Let's change target to foe and verify it fails
            DB.setValue("combattracker.list.id-00002.friendfoe", "foe")
            local result2 = EffectManager35E.checkConditional(rActor, nodeEffect, conds, rTarget)
            assert_eq(result2, false, "Faction friend check should fail for foe target")
        end)
    `;

    // Run test cases
    await lua.doString(testExecutionLua);

    // Retrieve test results
    const failures = await lua.global.get('test_failures');
    console.log(`\nTests finished. Total failures: ${failures}`);

    if (failures > 0) {
        process.exit(1);
    } else {
        console.log("All tests passed successfully!");
        process.exit(0);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
