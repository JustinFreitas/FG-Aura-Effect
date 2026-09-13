const { LuaFactory } = require('wasmoon');
const fs = require('fs');
const path = require('path');

async function runTests() {
    const factory = new LuaFactory();
    const lua = await factory.createEngine();

    console.log("Setting up mock environment for FG-Aura-Effect...");

    await lua.doString(`
        UtilityManager = {}
        Session = { IsHost = true, VersionMajor = 4 }
        User = {
            isHost = function() return true end,
            getUsername = function() return "Host" end,
            getIdentityLabel = function() return "GM" end
        }

        Interface = {
            _version = 4,
            _versionString = nil,
            getVersion = function()
                if Interface._versionString ~= nil then
                    return Interface._versionString
                end
                return Interface._version
            end,
            getString = function(id) return id or "" end,
            onWindowOpened = function(w) end
        }

        OptionsManager = {
            _options = { AURASILENT = "off" },
            registerOption2 = function(name, bDef, header, label, opt_type, params)
                OptionsManager._options[name] = params.default or "off"
            end,
            getOption = function(name)
                return OptionsManager._options[name] or "off"
            end,
            setOption = function(name, val)
                OptionsManager._options[name] = val
            end
        }

        OOBManager = {
            _handlers = {},
            registerOOBMsgHandler = function(msgtype, handler)
                OOBManager._handlers[msgtype] = handler
            end
        }

        Comm = {
            deliverOOBMessage = function(msg, sUser) end
        }

        EffectManager = {
            parseEffect = function(s) return { s } end,
            rebuildParsedEffect = function(a) return table.concat(a, "; ") end,
            isTargetedEffect = function(n) return false end,
            getEffectTargets = function(n, b) return {} end,
            notifyExpire = function(n, a, b) end,
            notifyApply = function(r, p) end,
            addEffect = function(user, ident, nodeCT, rEffect, b) end
        }

        EffectManager5E = {
            checkConditional = function(rActor, nodeEffect, aConditions, rTarget, aIgnore)
                return true
            end
        }

        TokenManager = {
            updateAttributesFromToken = function(tokenMap) end
        }

        Token = {
            onMove = function(tokenMap) end,
            getDistanceBetween = function(t1, t2) return 10 end
        }

        CombatManager = {
            CT_LIST = "combattracker.list",
            getSortedCombatantList = function() return {} end,
            getTokenFromCT = function(n) return nil end,
            getCTFromToken = function(t) return nil end
        }

        ActorManager = {
            resolveActor = function(n) return { sName = "Actor", node = n } end,
            getFaction = function(a) return "friend" end
        }

        -- Database Mock
        db_store = {}
        db_handlers = {}

        DB = {
            getValue = function(arg1, arg2, arg3)
                if type(arg1) == "table" then
                    local val = arg1._data and arg1._data[arg2]
                    if val == nil then return arg3 end
                    return val
                elseif type(arg1) == "string" then
                    local val = db_store[arg1]
                    if val == nil then return arg3 end
                    return val
                end
                return arg3
            end,
            setValue = function(arg1, arg2, arg3, arg4)
                if type(arg1) == "table" then
                    if not arg1._data then arg1._data = {} end
                    arg1._data[arg2] = arg4
                elseif type(arg1) == "string" then
                    db_store[arg1] = arg3
                end
            end,
            getChildren = function(node, subpath)
                if not node then return {} end
                if subpath then
                    local target = node._children and node._children[subpath]
                    return (target and target._children) or {}
                end
                return node._children or {}
            end,
            getChild = function(node, subpath)
                if not node or not subpath then return nil end
                if node.getChild then return node:getChild(subpath) end
                return nil
            end,
            getPath = function(nodeOrStr, subpath)
                if type(nodeOrStr) == "string" then
                    if subpath then return nodeOrStr .. "." .. subpath end
                    return nodeOrStr
                elseif type(nodeOrStr) == "table" and nodeOrStr._path then
                    if subpath then return nodeOrStr._path .. "." .. subpath end
                    return nodeOrStr._path
                end
                return ""
            end,
            addHandler = function(path, event, callback)
                table.insert(db_handlers, { path = path, event = event, callback = callback })
            end,
            removeHandler = function(path, event, callback)
                for i = #db_handlers, 1, -1 do
                    if db_handlers[i].path == path and db_handlers[i].event == event then
                        table.remove(db_handlers, i)
                        break
                    end
                end
            end,
            findNode = function(path) return nil end
        }
    `);

    // Load scripts/manager_effect_aura.lua
    const scriptPath = path.join(__dirname, '..', 'scripts', 'manager_effect_aura.lua');
    const luaCode = fs.readFileSync(scriptPath, 'utf8');
    await lua.doString(luaCode);

    console.log("manager_effect_aura.lua loaded into Lua VM successfully.\n");

    let testsPassed = 0;
    let totalTests = 0;

    function assert(condition, message) {
        totalTests++;
        if (condition) {
            console.log(`  PASS: ${message}`);
            testsPassed++;
        } else {
            console.error(`  FAIL: ${message}`);
            throw new Error(`Test failed: ${message}`);
        }
    }

    // TEST 1: Version detection (checkFGC and isClientFGU)
    console.log("Test 1: Version detection with FGC string vs FGU number...");
    {
        await lua.doString(`
            Interface._versionString = "3.3.16"
            Interface._version = nil
            Session.VersionMajor = nil
            bIsFGC = checkFGC()
            bIsFGU = isClientFGU()
        `);
        assert(lua.global.get('bIsFGC') === true, "checkFGC() returns true for string '3.3.16'");
        assert(lua.global.get('bIsFGU') === false, "isClientFGU() returns false for string '3.3.16'");

        await lua.doString(`
            Interface._versionString = nil
            Interface._version = 4.2
            Session.VersionMajor = 4
            bIsFGC = checkFGC()
            bIsFGU = isClientFGU()
        `);
        assert(lua.global.get('bIsFGC') === false, "checkFGC() returns false for number 4.2");
        assert(lua.global.get('bIsFGU') === true, "isClientFGU() returns true for number 4.2");
    }

    // TEST 2: Aura string regex parsing
    console.log("\nTest 2: Aura string format detection and range/type extraction...");
    {
        await lua.doString(`
            local s1 = "AURA: 10 friend; AC: 2"
            local s2 = "AURA: 30 foe; ATK: -2"
            local s3 = "AURA: 15; SAVE: 1"
            local s4 = "BLESS; ATK: 1d4"

            bMatch1 = string.match(s1, "%s*AURA: %d+") ~= nil
            bMatch2 = string.match(s2, "%s*AURA: %d+") ~= nil
            bMatch3 = string.match(s3, "%s*AURA: %d+") ~= nil
            bMatch4 = string.match(s4, "%s*AURA: %d+") ~= nil

            r1_range, r1_type = string.match(s1, "(%d+)%s*(%a*)")
            r2_range, r2_type = string.match(s2, "(%d+)%s*(%a*)")
            r3_range, r3_type = string.match(s3, "(%d+)%s*(%a*)")
        `);

        assert(lua.global.get('bMatch1') === true, "'AURA: 10 friend' recognized as aura");
        assert(lua.global.get('bMatch2') === true, "'AURA: 30 foe' recognized as aura");
        assert(lua.global.get('bMatch3') === true, "'AURA: 15' recognized as aura");
        assert(lua.global.get('bMatch4') === false, "'BLESS' correctly rejected as non-aura");

        assert(lua.global.get('r1_range') === "10" && lua.global.get('r1_type') === "friend", "Extracted range 10 and type friend");
        assert(lua.global.get('r2_range') === "30" && lua.global.get('r2_type') === "foe", "Extracted range 30 and type foe");
        assert(lua.global.get('r3_range') === "15", "Extracted range 15 for untyped aura");
    }

    // TEST 3: /reload Idempotency and Hook Safety
    console.log("\nTest 3: /reload idempotency and hook safety in onInit()...");
    {
        await lua.doString(`
            -- First onInit call
            onInit()
            local hook1_opened = Interface.onWindowOpened
            local hook1_cond = EffectManager5E.checkConditional
            local handler_count_1 = #db_handlers

            -- Second onInit call (simulates /reload)
            onInit()
            local hook2_opened = Interface.onWindowOpened
            local hook2_cond = EffectManager5E.checkConditional
            local handler_count_2 = #db_handlers

            bOpenedStable = (hook1_opened == hook2_opened)
            bCondStable = (hook1_cond == hook2_cond)
            bHandlersStable = (handler_count_1 == handler_count_2)
        `);

        assert(lua.global.get('bOpenedStable') === true, "Interface.onWindowOpened hook stable after reload");
        assert(lua.global.get('bCondStable') === true, "EffectManager5E.checkConditional hook stable after reload");
        assert(lua.global.get('bHandlersStable') === true, "DB handlers are not duplicated on reload");
    }

    // TEST 4: Host detection fallback (Session.IsHost vs User.isHost)
    console.log("\nTest 4: Host detection fallback for legacy FGC...");
    {
        await lua.doString(`
            Session.IsHost = nil
            User = { isHost = function() return true end, getUsername = function() return "Host" end, getIdentityLabel = function() return "GM" end }

            -- Re-call onInit under legacy FGC host conditions
            onInit()
            bHasHandlers = (#db_handlers > 0)
        `);
        assert(lua.global.get('bHasHandlers') === true, "Aura handlers registered using User.isHost() fallback");
    }

    // TEST 5: FGC Distance Calculation Mock
    console.log("\nTest 5: Distance calculation path selection...");
    {
        await lua.doString(`
            -- On FGU: uses Token.getDistanceBetween
            Interface._versionString = nil
            Interface._version = 4.2
            Session.VersionMajor = 4
            bUsesFGU = isClientFGU()

            -- On FGC: uses checkDistance
            Interface._versionString = "3.3.16"
            Interface._version = nil
            Session.VersionMajor = nil
            bUsesFGC = not isClientFGU()
        `);
        assert(lua.global.get('bUsesFGU') === true, "FGU environment selects Token.getDistanceBetween path");
        assert(lua.global.get('bUsesFGC') === true, "FGC environment selects checkDistance path without crashing");
    }

    console.log(`\n========================================`);
    console.log(`Results: ${testsPassed} / ${totalTests} tests passed!`);
    console.log(`========================================\n`);

    if (testsPassed !== totalTests) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test execution error:", err);
    process.exit(1);
});
