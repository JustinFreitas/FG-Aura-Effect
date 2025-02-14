--
--	Please see the LICENSE.md file included with this distribution for attribution and copyright information.
--

-- luacheck: globals updateAuras handleTokenMovement handleApplyEffectSilent handleExpireEffectSilent

OOB_MSGTYPE_AURATOKENMOVE = 'aurasontokenmove'
OOB_MSGTYPE_AURAAPPLYSILENT = 'applyeffsilent'
OOB_MSGTYPE_AURAEXPIRESILENT = 'expireeffsilent'

local fromAuraString = 'FROMAURA;'
local auraString = 'AURA: %d+'

local aEffectVarMap = {
	['nActive'] = { sDBType = 'number', sDBField = 'isactive' },
	['nDuration'] = { sDBType = 'number', sDBField = 'duration', vDBDefault = 1, sDisplay = '[D: %d]' },
	['nGMOnly'] = { sDBType = 'number', sDBField = 'isgmonly' },
	['nInit'] = { sDBType = 'number', sDBField = 'init', sSourceChangeSet = 'initresult', bClearOnUntargetedDrop = true },
	['sName'] = { sDBType = 'string', sDBField = 'label' },
	['sSource'] = { sDBType = 'string', sDBField = 'source_name', bClearOnUntargetedDrop = true },
	['sTarget'] = { sDBType = 'string', bClearOnUntargetedDrop = true },
	['sUnit'] = { sDBType = 'string', sDBField = 'unit' },
}

local function getEffectString(nodeEffect)
	local sLabel = DB.getValue(nodeEffect, 'label', '')

	local aEffectComps = EffectManager.parseEffect(sLabel)

	if EffectManager.isTargetedEffect(nodeEffect) then
		local sTargets = table.concat(EffectManager.getEffectTargets(nodeEffect, true), ',')
		table.insert(aEffectComps, 1, '[TRGT: ' .. sTargets .. ']')
	end

	for _, v in pairs(aEffectVarMap) do
		if v.fDisplay then
			local vValue = v.fDisplay(nodeEffect)
			if vValue then table.insert(aEffectComps, vValue) end
		elseif v.sDisplay and v.sDBField then
			local vDBValue
			if v.sDBType == 'number' then
				vDBValue = DB.getValue(nodeEffect, v.sDBField, v.vDBDefault or 0)
				if vDBValue == 0 then vDBValue = nil end
			else
				vDBValue = DB.getValue(nodeEffect, v.sDBField, v.vDBDefault or '')
				if vDBValue == '' then vDBValue = nil end
			end
			if vDBValue then table.insert(aEffectComps, string.format(v.sDisplay, tostring(vDBValue):upper())) end
		end
	end

	return EffectManager.rebuildParsedEffect(aEffectComps):gsub('%s*%(C%)', ''):gsub('%s*%[D: %d+%]', '')
end

local function isSourceDisabled(nodeChar)
	local rActor = ActorManager.resolveActor(nodeChar)
	if ActorHealthManager.isDyingOrDead(rActor) then
		return
	elseif ActorHealthManager.getHealthStatus(rActor) == ActorHealthManager.STATUS_UNCONSCIOUS then
		return
	end
end

local function getAurasForNode(nodeCT, searchString)
	local nodeEffects = DB.getChildren(nodeCT, 'effects')
	if not nodeEffects then return {} end

	local auraEffects = {}
	for _, nodeEffect in pairs(nodeEffects) do
		if DB.getValue(nodeEffect, aEffectVarMap['nActive']['sDBField'], 0) == 1 then
			local sLabelNodeEffect = getEffectString(nodeEffect)
			if sLabelNodeEffect:match(searchString) then table.insert(auraEffects, nodeEffect) end
		end
	end

	return auraEffects
end

local function checkSilentNotification(auraType)
	local option = OptionsManager.getOption('AURASILENT'):lower()
	return option == 'all' or option == auraType:lower():gsub('enemy', 'foe')
end

local function removeAuraEffect(auraType, nodeEffect)
	if DB.getValue(nodeEffect, aEffectVarMap['nActive']['sDBField'], 1) ~= 0 then
		if checkSilentNotification(auraType) == true then
			local function notifyExpireSilent()
				local varEffect
				if type(nodeEffect) == 'databasenode' then
					varEffect = nodeEffect.getPath()
				elseif type(nodeEffect) ~= 'string' then
					return false
				end

				local msgOOB = {}
				msgOOB.type = OOB_MSGTYPE_AURAEXPIRESILENT
				msgOOB.sEffectNode = varEffect

				Comm.deliverOOBMessage(msgOOB, '')
			end

			notifyExpireSilent()
		else
			EffectManager.notifyExpire(nodeEffect, nil, false)
		end
	end
end

---	This function is called when effects are removed or effect components are changed.
local function onEffectChanged(nodeEffect)
	if string.match(getEffectString(nodeEffect), auraString) and not string.match(getEffectString(nodeEffect), fromAuraString) then
		local nodeCT = nodeEffect.getChild('...')
		if nodeCT then
			if DB.getValue(nodeEffect, aEffectVarMap['nActive']['sDBField'], 0) ~= 1 then
				local function checkDeletedAuraEffects()
					local ctEntries = CombatManager.getSortedCombatantList()
					for _, node in pairs(ctEntries) do
						if node ~= nodeEffect then
							local function checkAurasEffectingNodeForDelete()
								for _, targetEffect in ipairs(getAurasForNode(node, fromAuraString)) do
									local targetEffectLabel = getEffectString(targetEffect)
									targetEffectLabel = targetEffectLabel:gsub(fromAuraString, '')
									if not string.find(targetEffectLabel, fromAuraString) then
										local sSource = DB.getValue(targetEffect, aEffectVarMap['sSource']['sDBField'], '')
										local sourceNode = DB.findNode(sSource)
										if sourceNode then
											local sourceAuras = getAurasForNode(sourceNode, auraString)
											local auraStillExists = false
											for _, sourceEffect in ipairs(sourceAuras) do
												local sourceEffectLabel = getEffectString(sourceEffect)
												if string.find(sourceEffectLabel, targetEffectLabel, 0, true) then
													auraStillExists = true
													break
												end
											end
											if not auraStillExists then removeAuraEffect('all', targetEffect) end
										end
									end
								end
							end

							checkAurasEffectingNodeForDelete()
						end
					end
				end

				checkDeletedAuraEffects()
			else
				updateAuras(nodeCT)
			end
		end
	end
end

---	This function is called when effect components are changed.
local function onStatusChanged(nodeStatus) updateAuras(nodeStatus.getChild('..')) end

---	This function requests aura processing to be performed on the host FG instance.
local function notifyTokenMove(tokenMap)
	if not tokenMap.getContainerNode or not CombatManager then return end
	local nodeCT = CombatManager.getCTFromToken(tokenMap)
	if not nodeCT then return end

	local msgOOB = {}
	msgOOB.type = OOB_MSGTYPE_AURATOKENMOVE
	msgOOB.sCTNode = nodeCT.getPath()

	Comm.deliverOOBMessage(msgOOB, '')
end

local function checkFaction(targetActor, nodeEffect, sFactionCheck)
	if not targetActor or not sFactionCheck then return false end

	local targetFaction = ActorManager.getFaction(targetActor)

	local sourceActor, sourceFaction
	local sEffectSource = DB.getValue(nodeEffect, aEffectVarMap['sSource']['sDBField'], '')
	if sFactionCheck:match('notself') then
		return sEffectSource ~= ''
	elseif sEffectSource ~= '' then
		sourceActor = ActorManager.resolveActor(DB.findNode(sEffectSource))
		sourceFaction = ActorManager.getFaction(sourceActor)
	else
		sourceFaction = targetFaction
	end

	local bReturn
	if sFactionCheck:match('friend') then
		bReturn = sourceFaction == targetFaction
	elseif sFactionCheck:match('foe') then
		if sourceFaction == 'friend' then
			bReturn = targetFaction == 'foe'
		elseif sourceFaction == 'foe' then
			bReturn = targetFaction == 'friend'
		end
	elseif sFactionCheck:match('neutral') then
		bReturn = targetFaction == 'neutral'
	elseif sFactionCheck:match('faction') then
		bReturn = targetFaction == 'faction'
	end

	if sFactionCheck:match('^!') then bReturn = not bReturn end

	return bReturn
end

local onMove = nil
local function auraOnMove(tokenMap, ...)
	if onMove then onMove(tokenMap, ...) end
	if Session.IsHost then
		-- Debug.chat("onMove aura update", tokenMap)
		notifyTokenMove(tokenMap)
	end
end

local function getRelationship(sourceNode, targetNode)
	if DB.getValue(sourceNode, 'friendfoe', '') == DB.getValue(targetNode, 'friendfoe', '') then
		return 'friend'
	else
		return 'foe'
	end
end

function updateAuras(sourceNode)
	if not sourceNode then return false end

	local ctEntries = CombatManager.getSortedCombatantList()
	for _, otherNode in pairs(ctEntries) do
		if otherNode and otherNode ~= sourceNode then
			local function checkAuraApplicationAndAddOrRemove(node1, node2, auraEffect, nodeInfo)
				if not auraEffect then return false end

				local sLabelNodeEffect = getEffectString(auraEffect)

				if sLabelNodeEffect:match(fromAuraString) then return false end

				local nRange, auraType = string.match(sLabelNodeEffect, 'AURA:%s*(%d+)%s*(%a*);')
				if nRange then
					nRange = math.floor(tonumber(nRange))
				else
					Debug.console(Interface.getString('aura_console_norange'))
					return false
				end
				if not auraType or auraType == '' then
					--Debug.console(Interface.getString('aura_console_nofaction'));
					auraType = 'all'
				elseif auraType == 'enemy' then
					auraType = 'foe'
				end

				if not nodeInfo.relationship then nodeInfo.relationship = getRelationship(node1, node2) end
				if auraType == nodeInfo.relationship or auraType == 'all' then
					if not nodeInfo.distanceBetween then
						local sourceToken = CombatManager.getTokenFromCT(node1)
						local targetToken = CombatManager.getTokenFromCT(node2)
						if sourceToken and targetToken then nodeInfo.distanceBetween = Token.getDistanceBetween(sourceToken, targetToken) end
					end

					local function checkAuraAlreadyEffecting()
						local sLabel = getEffectString(auraEffect)
						for _, nodeEffect in pairs(DB.getChildren(node2, 'effects')) do
							-- if DB.getValue(nodeEffect, aEffectVarMap["nActive"]["sDBField"], 0) ~= 2 then
							local sSource = DB.getValue(nodeEffect, aEffectVarMap['sSource']['sDBField'])
							if sSource == node1.getPath() then
								local sEffect = getEffectString(nodeEffect)
								sEffect = sEffect:gsub(fromAuraString, '')
								if string.find(sLabel, sEffect, 0, true) then return nodeEffect end
							end
							-- end
						end
					end

					local existingAuraEffect = checkAuraAlreadyEffecting()
					if (nodeInfo.distanceBetween and nodeInfo.distanceBetween <= nRange) and not isSourceDisabled(node1) then
						local function addAuraEffect()
							local sLabel = getEffectString(auraEffect)
							local applyLabel = string.match(sLabel, auraString .. '.-;%s*(.*)$')
							if not applyLabel then
								Debug.console(Interface.getString('aura_console_notext'), sLabel, auraString)
								return false
							end
							applyLabel = fromAuraString .. applyLabel

							local rEffect = {}
							rEffect.nDuration = 0
							rEffect.nGMOnly = DB.getValue(auraEffect, aEffectVarMap['nGMOnly']['sDBField'], 0)
							rEffect.nInit = DB.getValue(auraEffect, aEffectVarMap['nInit']['sDBField'], 0)
							rEffect.sLabel = applyLabel
							rEffect.sName = applyLabel
							rEffect.sSource = node1.getPath()
							--rEffect.sTarget = .... how to get targeting here?
							rEffect.sUnits = DB.getValue(auraEffect, aEffectVarMap['sUnit']['sDBField'], '')

							-- CHECK IF SILENT IS ON
							if checkSilentNotification(auraType) == true then
								local function notifyApplySilent()
									-- Build OOB message to pass effect to host
									local msgOOB = {}
									msgOOB.type = OOB_MSGTYPE_AURAAPPLYSILENT
									for k, _ in pairs(rEffect) do
										if aEffectVarMap[k] then
											if aEffectVarMap[k].sDBType == 'number' then
												msgOOB[k] = rEffect[k] or aEffectVarMap[k].vDBDefault or 0
											else
												msgOOB[k] = rEffect[k] or aEffectVarMap[k].vDBDefault or ''
											end
										end
									end
									if Session.IsHost then
										msgOOB.user = ''
									else
										msgOOB.user = User.getUsername()
									end
									msgOOB.identity = User.getIdentityLabel()

									-- Send one message for each target
									if type(node2.getPath()) == 'table' then
										for _, v in pairs(node2.getPath()) do
											msgOOB.sTargetNode = v
											Comm.deliverOOBMessage(msgOOB, '')
										end
									else
										msgOOB.sTargetNode = node2.getPath()
										Comm.deliverOOBMessage(msgOOB, '')
									end
								end

								notifyApplySilent(rEffect)
							else
								EffectManager.notifyApply(rEffect, node2.getPath())
							end
						end

						if not existingAuraEffect then addAuraEffect() end
					elseif existingAuraEffect then
						removeAuraEffect(auraType, existingAuraEffect)
					end
				end
			end

			local nodeInfo = {}
			-- Check if the moved token has auras to apply/remove
			for _, auraEffect in pairs(getAurasForNode(sourceNode, auraString)) do
				checkAuraApplicationAndAddOrRemove(sourceNode, otherNode, auraEffect, nodeInfo)
			end
			-- Check if the moved token is subject to other's auras
			for _, auraEffect in pairs(getAurasForNode(otherNode, auraString)) do
				checkAuraApplicationAndAddOrRemove(otherNode, sourceNode, auraEffect, nodeInfo)
			end
		end
	end
end

function handleTokenMovement(msgOOB) updateAuras(DB.findNode(msgOOB.sCTNode)) end

function handleApplyEffectSilent(msgOOB)
	-- Get the target combat tracker node
	local nodeCTEntry = DB.findNode(msgOOB.sTargetNode)
	if not nodeCTEntry then
		ChatManager.SystemMessage(Interface.getString('ct_error_effectapplyfail') .. ' (' .. msgOOB.sTargetNode .. ')')
		return false
	end

	-- Reconstitute the effect details
	local rEffect = {}
	for k, _ in pairs(msgOOB) do
		if aEffectVarMap[k] then
			if aEffectVarMap[k].sDBType == 'number' then
				rEffect[k] = tonumber(msgOOB[k]) or 0
			else
				rEffect[k] = msgOOB[k]
			end
		end
	end

	-- Apply the effect
	EffectManager.addEffect(msgOOB.user, msgOOB.identity, nodeCTEntry, rEffect, false)
end

---	This function creates and removes handlers on the effects list
local function manageHandlers(bRemove)
	if bRemove then
		DB.removeHandler(DB.getPath(CombatManager.CT_LIST .. '.*.effects.*'), 'onChildUpdate', onEffectChanged)
		DB.removeHandler(DB.getPath(CombatManager.CT_LIST .. '.*.effects'), 'onChildDeleted', onEffectChanged)
		DB.removeHandler(DB.getPath(CombatManager.CT_LIST .. '.*.status'), 'onUpdate', onStatusChanged)
	else
		DB.addHandler(DB.getPath(CombatManager.CT_LIST .. '.*.effects.*'), 'onChildUpdate', onEffectChanged)
		DB.addHandler(DB.getPath(CombatManager.CT_LIST .. '.*.effects'), 'onChildDeleted', onEffectChanged)
		DB.addHandler(DB.getPath(CombatManager.CT_LIST .. '.*.status'), 'onUpdate', onStatusChanged)
	end
end

local function expireEffectSilent(nodeEffect)
	if not nodeEffect then
		-- Debug.chat(nodeActor, nodeEffect, nExpireComp)
		return false
	end

	---	This function removes nodes without triggering recursion
	local function removeNode()
		manageHandlers(true)
		nodeEffect.delete()
		manageHandlers(false)
	end

	-- Process full expiration
	removeNode()
end

function handleExpireEffectSilent(msgOOB)
	local nodeEffect = DB.findNode(msgOOB.sEffectNode)
	if not nodeEffect then
		Debug.console(Interface.getString('aura_console_expire_nonode'))
		-- ChatManager.SystemMessage(Interface.getString("ct_error_effectdeletefail") .. " (" .. msgOOB.sEffectNode .. ")");
		return
	end
	local nodeActor = nodeEffect.getChild('...')
	if not nodeActor then
		ChatManager.SystemMessage(Interface.getString('ct_error_effectmissingactor') .. ' (' .. msgOOB.sEffectNode .. ')')
		return
	end

	expireEffectSilent(nodeEffect)
end

local handleExpireEffect_old
local function PFRPG2handleExpireEffect(msgOOB, ...)
	if DB.findNode(msgOOB.sEffectNode) then handleExpireEffect_old(msgOOB, ...) end
end

function onInit()
	-- register option for silent aura messages
	OptionsManager.registerOption2('AURASILENT', false, 'option_header_aura', 'option_label_AURASILENT', 'option_entry_cycler', {
		labels = 'option_val_friend|option_val_foe|option_val_all',
		values = 'friend|foe|all',
		baselabel = 'option_val_off',
		baseval = 'off',
		default = 'off',
	})

	-- register OOB message handlers to allow player movement
	OOBManager.registerOOBMsgHandler(OOB_MSGTYPE_AURATOKENMOVE, handleTokenMovement)
	OOBManager.registerOOBMsgHandler(OOB_MSGTYPE_AURAAPPLYSILENT, handleApplyEffectSilent)
	OOBManager.registerOOBMsgHandler(OOB_MSGTYPE_AURAEXPIRESILENT, handleExpireEffectSilent)

	-- set up the effect manager proxy functions for the detected ruleset
	local DetectedEffectManager = nil
	if EffectManager35E then
		DetectedEffectManager = EffectManager35E
	elseif EffectManagerPFRPG2 then
		DetectedEffectManager = EffectManagerPFRPG2
		handleExpireEffect_old = EffectManager.handleExpireEffect
		OOBManager.registerOOBMsgHandler('expireeff', PFRPG2handleExpireEffect)
		EffectManager.handleExpireEffect = PFRPG2handleExpireEffect
	elseif EffectManagerSFRPG then
		DetectedEffectManager = EffectManagerSFRPG
	elseif EffectManager5E then
		DetectedEffectManager = EffectManager5E
	elseif EffectManager4E then
		DetectedEffectManager = EffectManager4E
	end

	local checkConditional = nil
	local function customCheckConditional(rActor, nodeEffect, aConditions, rTarget, aIgnore)
		local bReturn = checkConditional(rActor, nodeEffect, aConditions, rTarget, aIgnore)
		if aConditions and aConditions.remainder then aConditions = aConditions.remainder end
		for _, v in ipairs(aConditions) do
			local sFactionCheck = v:lower():match('^faction%s*%(([^)]+)%)$')
			if sFactionCheck then
				if not checkFaction(rActor, nodeEffect, sFactionCheck) then
					bReturn = false
					break
				end
			end
		end
		return bReturn
	end

	-- create proxy function to add FACTION conditional
	checkConditional = DetectedEffectManager.checkConditional
	DetectedEffectManager.checkConditional = customCheckConditional

	local onWindowOpened = nil
	local function auraOnWindowOpened(window, ...)
		if onWindowOpened then onWindowOpened(window, ...) end
		if window.getClass() == 'imagewindow' then
			local ctEntries = CombatManager.getSortedCombatantList()
			for _, nodeCT in pairs(ctEntries) do
				local tokenMap = CombatManager.getTokenFromCT(nodeCT)
				local _, winImage = ImageManager.getImageControl(tokenMap)
				if tokenMap and winImage == window then notifyTokenMove(tokenMap) end
			end
		end
	end

	-- create proxy function to recalculate auras when new windows are opened
	onWindowOpened = Interface.onWindowOpened
	Interface.onWindowOpened = auraOnWindowOpened

	-- create the proxy function to trigger aura calculation on token movement.
	onMove = Token.onMove
	Token.onMove = auraOnMove

	-- all handlers should be created on GM machine
	if Session.IsHost then manageHandlers(false) end
end
