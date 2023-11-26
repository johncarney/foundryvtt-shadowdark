export default class RollSD extends Roll {

	/**
	 * Main roll method for rolling. It checks if the roll is a
	 * d20, and if true, checks for special cases.
	 *
	 * The `data` object generally just needs an `actor` or and `item` as key:values.
	 *
	 * The `options` object configures the rolls, and chat messages. The following optional keys
	 * may be used:
	 * - fastForward {boolean}: Skips dialogs and just rolls normal rolls if set to true
	 * - rollMode {string}: If the self/gm/blind/public roll mode is to be predetermined
	 * - flavor {string}: Flavor text on the chat card (smaller text under actor name)
	 * - title {string}: Title of the chat card, set next to the icon
	 * - target {number}: If the roll has a target to meet or beat
	 * - dialogTemplate {handlebars}: Handlebars template to base Dialog on
	 * - dialogTitle {string}: The title of the rendered dialog
	 * - dialogOptions {object}: Options to be sent to the Dialog renderer
	 * - chatCardTemplate {handlebars}: Handlebars template to base Chatcard on
	 * - speaker {object}: Speaker as generated by `ChatMessage.getSpeaker()`
	 * - chatMessage {boolean}: Set to false if no chat message should be generated
	 *
	 * @param {Array<string>}		- Parts for the roll
	 * @param {object} data 		- Data that carries actor and/or item
	 * @param {jQuery} $form 		- Form from an evaluated dialog
	 * @param {number} adv			- Determine the direction of advantage (1)
	 * / disadvantage (-1)
	 * @param {object} options	- Options to modify behavior
	 * @returns {Promise<object>}
	 */
	static async Roll(parts, data, $form, adv=0, options={}) {
		// If the dice has been fastForwarded, there is no form
		if (!options.fastForward) {
			// Augment data with form bonuses & merge into data
			const formBonuses = this._getBonusesFromForm($form);
			data = foundry.utils.mergeObject(data, formBonuses);
		}

		if (!options.rollMode) {
			// only override if it's actually been set on the form (some rolls
			// will have no form)
			options.rollMode = $form
				? this._getRollModeFromForm($form)
				: game.settings.get("core", "rollMode");
		}

		// Roll the Dice
		data.rolls = {
			main: await this._rollAdvantage(parts, data, adv),
		};

		if (data.rollType === "ability") {
			return this._renderRoll(data, adv, options);
		}

		if (data.rollType === "hp") {
			return this._renderRoll(data, adv, options);
		}

		// Roll damage for NPCs
		if (data.actor?.type === "NPC" && data.item.type === "NPC Attack") {
			data = await this._rollNpcAttack(data);
			if (!options.flavor) {
				options.flavor = game.i18n.format(
					"SHADOWDARK.chat.item_roll.title",
					{
						name: data.item.name,
					}
				);
			}
			return this._renderRoll(data, adv, options);
		}

		// Special cases for D20 rolls
		if (this._isD20(parts)) {
			// Weapon? -> Roll Damage dice
			if (data.item?.isWeapon()) {
				data = await this._rollWeapon(data);
				if (!options.flavor) {
					options.flavor = game.i18n.format(
						"SHADOWDARK.chat.item_roll.title",
						{
							name: data.item.name,
						}
					);
				}
			}

			// Spell? -> Set a target
			if (data.item?.isSpell()) {
				// NPC spell
				if (typeof data.item.system.dc !== "undefined") {
					options.target = data.item.system.dc;
					options.tier = data.item.system.dc - 10;
					// system.tier needed for spell chat template
					data.item.system.tier = options.tier;
				}
				// player spell
				else {
					options.target = data.item.system.tier + 10;
					options.tier = data.item.system.tier;
				}
				if (!options.flavor) {
					options.flavor = game.i18n.format(
						"SHADOWDARK.chat.spell_roll.title",
						{
							name: data.item.name,
							tier: options.tier,
							spellDC: options.target,
						}
					);
				}
			}
		}

		// Check if it was a spell, and if it failed, lose it
		const result = await this._renderRoll(data, adv, options);
		if (
			data.item?.isSpell()
			&& result
			&& !result?.rolls?.main?.success
		) data.item.update({"system.lost": true});
		return result;
	}

	/* -------------------------------------------- */
	/*  Roll Analysis                               */
	/* -------------------------------------------- */

	/**
	 * Checks if the roll is a D20 roll.
	 * @param {Array<string>} parts - Roll parts, starting with main dice
	 * @returns {boolean}
	 */
	static _isD20(parts) {
		if (typeof parts[0] !== "string") return false;
		if (parts[0] && parts[0].split("d")) return (parseInt(parts[0].split("d")[1], 10) === 20);
		return false;
	}

	/**
	 * Checks if a d20 has been rolled with either a result of
	 * 1 (failure) or 20 (success) and returns that as a string.
	 *
	 * Options:
	 * - critical.failureThreshold: Modified lower threshold for critical failure
	 * - critical.successThreshold: Modified higher threshold for critical success
	 *
	 * @param {Roll} roll 			- Roll results
	 * @param {object} options	- Options for the critical check
	 * @returns {string|null} 	- Analysis result
	 */
	static _digestCritical(roll, options={}) {
		if ( roll.terms[0].faces !== 20 ) return null;

		// Check if different threshold are given as options
		const failureThreshold = (options.critical?.failureThreshold)
			? options.critical.failureThreshold : 1;

		const successThreshold = (options.critical?.successThreshold)
			? options.critical.successThreshold : 20;

		// Get the final result if using adv/disadv
		if ( roll.terms[0].total >= successThreshold ) return "success";
		else if ( roll.terms[0].total <= failureThreshold ) return "failure";
		return null;
	}

	/**
	 * Removes the `@bonus` valeus from `parts` array that do not have
	 * corresponding `data.bonus` value, for a cleaner roll.
	 * @param {Array<string>} parts - Parts with bonuses to add to roll, starting with at
	 * @param {object} data 				- Data object containing `data.bonusX` values
	 * @returns {Array<string>}			- Parts with only defined bonuses in data object
	 */
	static _digestParts(parts, data) {
		const reducedParts = [];
		parts.forEach(part => {
			// If both the bonus is defined, and not 0, push to the results
			if (
				data[part.substring(1)] && parseInt(data[part.substring(1)], 10) !== 0
			) reducedParts.push(part);
		});
		return reducedParts;
	}

	/**
	 * Modifies the first term in `rollParts` to roll with either advantage
	 * or disadvantage. Does nothing if multiple dice are first parts.
	 * @param {Array<string>} rollParts	- Array containing parts for rolling
	 * @param {-1|0|1} adv 							- Pre-determined Advantage
	 * @returns {Array<string>}					- Modified rollParts
	 */
	static _partsAdvantage(rollParts,	adv=0) {
		const splitDice = rollParts[0].split("d");
		if (parseInt(splitDice[0], 10) !== 1) return rollParts;

		if (adv === 1) {
			rollParts[0] = `${splitDice[0] * 2}d${splitDice[1]}kh`;
		}
		else if (adv === -1) {
			rollParts[0] = `${splitDice[0] * 2}d${splitDice[1]}kl`;
		}
		return rollParts;
	}

	/* -------------------------------------------- */
	/*  Dice Rolling                                */
	/* -------------------------------------------- */

	/**
	 * Rolls dice, with parts. Evaluates them, and returns the data.
	 * @param {Array<string>}	parts	- Dice and Bonuses associated with the roll `@bonus`
	 * @param {object} data					- Data for the roll, incl. values for bonuses, like
	 * `data.bonus`
	 * @returns {object} 						- Returns the evaluated `roll`, the rendered
	 * HTML `renderedHTML`, and `critical` info.
	 */
	static async _roll(parts, data={}) {
		// Check the numDice has been given, otherwise add 1 dice
		if (parts[0][0] === "d") parts[0] = `1${parts[0]}`;

		// Save the first entry, assuming this is the main dice
		const mainDice = parts[0];

		parts = this._digestParts(parts, data);

		// Put back the main dice
		parts.unshift(mainDice);

		const roll = await new Roll(parts.join(" + "), data).evaluate({async: true});
		const renderedHTML = await roll.render();

		// Also send the actors critical bonuses in case it has modified thresholds
		const critical = this._digestCritical(roll, data.actor?.system?.bonuses);

		return {
			roll,
			renderedHTML,
			critical,
		};
	}

	/**
	 * Modifies the first dice to roll it with advantage (2dXkh) or
	 * disadvantage (2dXkl).
 	 * @param {Array<string>} parts - Main Dice, and bonus parts (`@bonus`)
	 * @param {object} data 				- Data carrying object for use in roll.
	 * @param {-1|0|1} adv 					- Determine the direction of advantage (1)
	 * / disadvantage (-1) or normal (0).
	 * @returns {object}						- Object containing evaluated roll data
	 */
	static async _rollAdvantage(parts, data={}, adv=0) {
		parts = this._partsAdvantage(parts, adv);
		return this._roll(parts, data);
	}

	/**
	 * Analyses provided `data` and rolls with supplied bonuses, and advantage if
	 * requested.
	 * @param {Array<string>} parts - Bonus parts (@bonus) for consideration in roll
	 * @param {object} data 				- Data carrying object for use in roll.
	 * @param {-1|0|1} adv 					- Determine the direction of advantage (1)
	 * 																/ disadvantage (-1)
	 * @returns {object}						- Object containing evaluated roll data
	 */
	static async _rollD20(parts = [], data={}, adv=0) {
		// Modify the d20 to take advantage in consideration
		if ( parts[0] !== "1d20") parts.unshift("1d20");
		return this._rollAdvantage(parts, data, adv);
	}

	/* -------------------------------------------- */
	/*  Special Case Rolling                        */
	/* -------------------------------------------- */

	/**
	 * Rolls an NPC attack.
	 * @param {object} data - Object containing the item document of rolled item
	 * @returns {object}		- Returns the data object, with additional roll evaluations
	 */
	static async _rollNpcAttack(data) {
		let baseDamageFormula = data.item.system.damage.value ?? "";
		baseDamageFormula = baseDamageFormula.trim();

		// Default to 1 damage if no damage formula has been set
		baseDamageFormula = baseDamageFormula === "" ? "1" : baseDamageFormula;

		// Get bonus damage
		data.damageBonus = data.item.system.bonuses.damageBonus;
		if (data.damageBonus) data.damageParts.push("@damageBonus");

		if (data.rolls.main.critical !== "failure") {
			if (data.rolls.main.critical === "success") {
				// We only support multiplication of the first damage dice,
				// which is probably enough. None of the core game NPC attacks
				// involve multiple dice parts
				//
				if (baseDamageFormula !== "0") {
					const parts = /^(\d*)d(.*)/.exec(baseDamageFormula);

					let numDice = "1";
					let formulaSuffix = "";
					if (parts) {
						numDice = parts[1] !== "" ? parts[1] : "1";
						formulaSuffix = parts[2] ? parts[2] : "";
					}

					numDice = parseInt(numDice, 10);
					numDice *= parseInt(data.item.system.bonuses.critical.multiplier, 10);

					baseDamageFormula = formulaSuffix !== ""
						? `${numDice}d${formulaSuffix}`
						: `${numDice}`;
				}
			}

			const primaryParts = [baseDamageFormula, ...data.damageParts];

			data.rolls.primaryDamage = await this._roll(primaryParts, data);
		}

		return data;
	}

	/**
	 * Rolls a weapon when suppled in the `data` object.
	 * @param {object} data - Object containing the item document of rolled item
	 * @returns {object} - Returns the data object, with additional roll evaluations
	 */
	static async _rollWeapon(data) {
		// Get dice information from the weapon
		let numDice = data.item.system.damage.numDice;
		let damageDie = await data.item.isTwoHanded()
			?	data.item.system.damage.twoHanded
			: data.item.system.damage.oneHanded;

		let versatileDamageDie = await data.item.isVersatile()
			? data.item.system.damage.twoHanded
			: false;

		// Improve the base damage die if this weapon has the relevant property
		const weaponDamageDieImprovementByProperty =
			data.actor.system.bonuses.weaponDamageDieImprovementByProperty ?? [];

		for (const property of weaponDamageDieImprovementByProperty) {
			if (await data.item.hasProperty(property)) {
				damageDie = shadowdark.utils.getNextDieInList(
					damageDie,
					shadowdark.config.DAMAGE_DICE
				);

				if (versatileDamageDie) {
					versatileDamageDie = shadowdark.utils.getNextDieInList(
						versatileDamageDie,
						shadowdark.config.DAMAGE_DICE
					);
				}
			}
		}

		// Check if damage die is modified by talent
		if (data.actor.system.bonuses.weaponDamageDieD12.some(
			t => [data.item.name.slugify(), data.item.system.baseWeapon.slugify()].includes(t)
		)) {
			damageDie = "d12";
			if (versatileDamageDie) versatileDamageDie = "d12";
		}

		// Check and handle critical failure/success
		if ( data.rolls.main.critical !== "failure" ) {
			let primaryParts = [];

			// Adds dice if backstabbing
			if (data.backstab) {
				// Additional dice
				numDice += 1 + Math.floor(data.actor.system.level.value / 2);
				if (data.actor.system.bonuses.backstabDie) numDice +=
					parseInt(data.actor.system.bonuses.backstabDie, 10);
			}

			// Multiply the dice with the items critical multiplier
			if ( data.rolls.main.critical === "success") numDice
				*= parseInt(data.item.system.bonuses.critical.multiplier, 10);

			// Check if a damage multiplier is active for either Weapon or Actor
			const damageMultiplier = Math.max(
				parseInt(data.item.system.bonuses.damageMultiplier ?? 0, 10),
				parseInt(data.actor.system.bonuses.damageMultiplier ?? 0, 10),
				1);

			const primaryDmgRoll = (damageMultiplier > 1)
				? `${numDice}${damageDie} * ${damageMultiplier}`
				: `${numDice}${damageDie}`;

			primaryParts = [primaryDmgRoll, ...data.damageParts];

			data.rolls.primaryDamage = await this._roll(primaryParts, data);

			if (versatileDamageDie) {
				const secondaryDmgRoll = (damageMultiplier > 1)
					? `${numDice}${versatileDamageDie} * ${damageMultiplier}`
					: `${numDice}${versatileDamageDie}`;
				const secondaryParts = [secondaryDmgRoll, ...data.damageParts];
				data.rolls.secondaryDamage = await this._roll(secondaryParts, data);
			}
		}
		return data;
	}

	/* -------------------------------------------- */
	/*  Dialog & Form Digestion                     */
	/* -------------------------------------------- */

	/**
	 * Extract the roll mode from a form
	 * @param {jQuery} $form 	- Callback HTML from dialog
	 * @returns {string}			- Selected Rollmode
	 */
	static _getRollModeFromForm($form) {
		return $form.find("[name=rollMode]").val();
	}

	/**
	 * Parses a submitted dialog form for bonuses
	 * @param {jQuery} $form 	- Submitted dialog form
	 * @returns {object}			- Bonuses from the dialog form
	 */
	static _getBonusesFromForm($form) {
		const bonuses = {};
		if ($form.find("[name=item-bonus]").length) bonuses.itemBonus = $form.find("[name=item-bonus]")?.val();
		if ($form.find("[name=ability-bonus]").length) bonuses.abilityBonus = $form.find("[name=ability-bonus]")?.val();
		if ($form.find("[name=talent-bonus]").length) bonuses.talentBonus = $form.find("[name=talent-bonus]")?.val();
		if ($form.find("[name=weapon-backstab]").length) bonuses.backstab = $form.find("[name=weapon-backstab]")?.prop("checked");
		return bonuses;
	}

	/* -------------------------------------------- */
	/*  Dialogs                                     */
	/* -------------------------------------------- */

	/**
	 * Renders HTML for display as roll dialog
	 * @param {Array<string>} parts		- Dice formula parts
	 * @param {object} data 					- Data for use in the dialog
	 * @param {object} options 				- Configuration options for dialog
	 * @returns {jQuery}							- Rendered HTML object
	 */
	static async _getRollDialogContent(
		parts,
		data,
		options = {}
	) {
		const dialogTemplate = options.dialogTemplate
			? options.dialogTemplate
			: "systems/shadowdark/templates/dialog/roll-dialog.hbs";

		const dialogData = {
			data,
			title: options.title,
			formula: Array.from(parts).join(" + "),
			rollModes: CONFIG.Dice.rollModes,
			rollMode: options.rollMode,
		};

		// If rollMode is already specified, don't override it
		if (!dialogData.rollMode) {
			dialogData.rollMode = game.settings.get("core", "rollMode");
		}

		return renderTemplate(dialogTemplate, dialogData);
	}

	/**
	 * Renders a Roll Dialog and displays the appropriate bonuses
	 * @param {Array<string>} parts - Predetermined roll dice & @bonuses
	 * @param {object} data 				- Data container with dialogTitle
	 * @param {object} options 			- Configuration options for dialog
	 * @returns {Promise(Roll)}			- Returns the promise of evaluated roll(s)
	 */
	static async RollDialog(parts, data, options={}) {
		if ( options.fastForward ) {
			return await this.Roll(parts, data, false, 0, options);
		}

		if (!options.title) {
			options.title = game.i18n.localize("SHADOWDARK.dialog.roll");
		}
		// Render the HTML for the dialog
		let content = await this._getRollDialogContent(parts, data, options);

		const dialogData = {
			title: options.title,
			content,
			classes: ["shadowdark-dialog"],
			buttons: {
				advantage: {
					label: game.i18n.localize("SHADOWDARK.roll.advantage"),
					callback: async html => {
						return this.Roll(parts, data, html, 1, options);
					},
				},
				normal: {
					label: game.i18n.localize("SHADOWDARK.roll.normal"),
					callback: async html => {
						return this.Roll(parts, data, html, 0, options);
					},
				},
				disadvantage: {
					label: game.i18n.localize("SHADOWDARK.roll.disadvantage"),
					callback: async html => {
						return this.Roll(parts, data, html, -1, options);
					},
				},
			},
			close: () => null,
			default: "normal",
			render: html => {
				// Check if the actor has advantage, and add highlight if that
				// is the case
				if (data.actor?.hasAdvantage(data)) {
					html.find("button.advantage")
						.attr("title", game.i18n.localize(
							"SHADOWDARK.dialog.tooltip.talent_advantage"
						))
						.addClass("talent-highlight");
				}
			},
		};

		return Dialog.wait(dialogData, options.dialogOptions);
	}

	/* -------------------------------------------- */
	/*  Chat Card Generation for Displaying         */
	/* -------------------------------------------- */

	/**
	 * Parse roll data and optional target value
	 * @param {object} rollResult 		- Response from `_roll()`
	 * @param {object} speaker  			- ChatMessage.getSpeaker who will be sending the message
	 * @param {number|false} target 	- Target value to beat with the roll
	 * @return {object}								- Data for rendering a chatcard
	 */
	static _getChatCardData(rolls, speaker, target=false) {
		const chatData = {
			user: game.user.id,
			speaker: speaker,
			flags: {
				"isRoll": true,
				"rolls": rolls,
				"core.canPopout": true,
				"hasTarget": target !== false,
				"critical": rolls.main.critical,
			},
		};
		if (target) chatData.flags.success = rolls.main.roll.total >= target;
		return chatData;
	}

	/**
	 * Generate Template Data for displaying custom chat cards
	 * @param {object} data 		- Optional data containing `item` and `actor`
	 * @param {object} options 	- Optional options for configuring chat card,
	 * e.g. `flavor`, `title`
	 * @returns {object}				- Data to populate the Chat Card template
	 */
	static async _getChatCardTemplateData(data, options={}) {
		const templateData = {
			data,
			title: (options.title) ? options.title : game.i18n.localize("SHADOWDARK.chatcard.default"),
			flavor: (options.flavor)
				? options.flavor : (options.title)
					? options.title : game.i18n.localize("SHADOWDARK.chatcard.default"),
			isSpell: false,
			isWeapon: false,
			isVersatile: false,
			isRoll: true,
			isNPC: data.actor?.type === "NPC",
			targetDC: options.target ?? false,
		};
		if (data.rolls.main) {
			templateData._formula = data.rolls.main.roll._formula;
		}
		if (data.item) {
			templateData.isSpell = data.item.isSpell();
			templateData.isWeapon = data.item.isWeapon();
			templateData.isVersatile = await data.item.isVersatile();

			const propertyNames = [];

			for (const property of await data.item.propertyItems()) {
				propertyNames.push(property.name);
			}

			templateData.propertyNames = propertyNames;
		}
		return templateData;
	}

	/**
	 * Generate HTML for a chat card for a roll
	 * @param {object} data 		- Optional data containing `item` and `actor`
	 * @param {object} options 	- Optional options for configuring chat card,
	 * e.g. `flavor`, `title`
	 * @returns {jQuery}				- Rendered HTML for chat card
	 */
	static async _getChatCardContent(
		data,
		options = {}
	) {
		const chatCardTemplate = options.chatCardTemplate
			? options.chatCardTemplate
			: "systems/shadowdark/templates/chat/roll-card.hbs";

		const chatCardData = await this._getChatCardTemplateData(data, options);

		return renderTemplate(chatCardTemplate, chatCardData);
	}

	/**
	 * Takes a data objcet containing rolls and renders them. Also optionally
	 * renders 3D Dice using Dice So Nice integration.
	 * @param {object} data 			- Data from rolling
	 * @param {-1|0|1} adv 				- Advantage indicator
	 * @param {object} options 		- Optional configuration for chat card
	 * @returns {Promise<object>}
	 */
	static async _renderRoll(data, adv=0, options={}) {
		const chatData = await this._getChatCardData(
			data.rolls,
			(options.speaker) ? options.speaker : ChatMessage.getSpeaker(),
			options.target
		);

		// TODO: Write tests for this.
		// Add whether the roll succeeded or not to the roll data
		data.rolls.main.success = (chatData.flags.success)
			? chatData.flags.success
			: null;

		if ( options.rollMode === "blindroll" ) data.rolls.main.blind = true;

		const content = await this._getChatCardContent(data, options);

		chatData.content = content;

		// Modify the flavor of the chat card
		if (options.flavor) {
			chatData.flavor = options.flavor;

			switch (adv) {
				case 1:
					chatData.flavor = game.i18n.format(
						"SHADOWDARK.roll.advantage_title",
						{ title: options.flavor }
					);
					break;
				case -1:
					chatData.flavor = game.i18n.format(
						"SHADOWDARK.roll.disadvantage_title",
						{ title: options.flavor }
					);
					break;
			}
		}

		// Integration with Dice So Nice
		if (game.dice3d) {
			await this._rollDiceSoNice(data.rolls, chatData, options.chatMessage);
		}
		else {
			chatData.sound = CONFIG.sounds.dice;
		}

		if (options.chatMessage !== false) {
			ChatMessage.applyRollMode(chatData, options.rollMode);
			ChatMessage.create(chatData);
		}

		return data;
	}

	/* -------------------------------------------- */
	/*  Integrations                                */
	/* -------------------------------------------- */

	/**
	 * Renders Dice So Nice in order of D20 -> Damage Rolls and creates
	 * a chat message with the generated content.
	 * @param {object} rolls 					- Object containing evaluated rolls
	 * @param {object} chatData 			- Parsed roll data as generated by _getchatCardData
	 * 																  augmented with content from
	 *                                  _getChatCardTemplateData
	 * @param {boolean} chatMessage 	- Boolean to display chat message or just generate it
	 * @return {object}								- Returns the D20 result
	 */
	static async _rollDiceSoNice(rolls) {
		const rollsToShow = [rolls.main.roll];

		if ( rolls.primaryDamage ) {
			rollsToShow.push(rolls.primaryDamage.roll);
		}
		if ( rolls.secondaryDamage ) {
			rollsToShow.push(rolls.secondaryDamage.roll);
		}

		// TODO Make sure we honor the whisper and/or blind settings of the roll
		//
		// Only await on the final dice roll of the sequence as it looks nicer
		// if all the dice roll before the chat message appears
		const numRolls = rollsToShow.length;
		let currentRoll = 1;
		for (const roll of rollsToShow) {
			if (currentRoll === numRolls) {
				await game.dice3d.showForRoll(roll, game.user, true);
			}
			else {
				game.dice3d.showForRoll(roll, game.user, true);
			}
			currentRoll++;
		}
	}
}
