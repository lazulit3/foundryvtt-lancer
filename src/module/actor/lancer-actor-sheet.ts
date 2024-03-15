import { LANCER } from "../config";
import { handleGenControls, handlePopoutTextEditor } from "../helpers/commons";
import { handleDocDropping, ResolvedDropData } from "../helpers/dragdrop";
import { handleCounterInteraction, handleInputPlusMinusButtons, handlePowerUsesInteraction } from "../helpers/item";
import { handleRefDragging, handleRefSlotDropping, handleRefClickOpen, handleUsesInteraction } from "../helpers/refs";
import type { LancerActorSheetData } from "../interfaces";
import { LancerItem } from "../item/lancer-item";
import { LancerActor, LancerActorType } from "./lancer-actor";
import { prepareChargeMacro, runEncodedMacro } from "../macros";
import { ActivationOptions } from "../enums";
import { applyCollapseListeners, CollapseHandler, initializeCollapses } from "../helpers/collapse";
import { addExportButton } from "../helpers/io";
import type { ActionType } from "../action";
import { InventoryDialog } from "../apps/inventory";
import { handleContextMenus } from "../helpers/item";
import { getActionTrackerOptions } from "../settings";
import { modAction } from "../action/action-tracker";
import { insinuate } from "../util/doc";
import { PrototypeTokenData } from "@league-of-foundry-developers/foundry-vtt-types/src/foundry/common/data/data.mjs";
import { LancerActiveEffect } from "../effects/lancer-active-effect";
import { LancerFlowState } from "../flows/interfaces";
import { lookupOwnedDeployables } from "../util/lid";
import { beginItemChatFlow } from "../flows/item";
const lp = LANCER.log_prefix;

/**
 * Extend the basic ActorSheet
 */
export class LancerActorSheet<T extends LancerActorType> extends ActorSheet<
  ActorSheet.Options,
  LancerActorSheetData<T>
> {
  // Tracks collapse state between renders
  protected collapse_handler = new CollapseHandler();

  static get defaultOptions(): ActorSheet.Options {
    return mergeObject(super.defaultOptions, {
      scrollY: [".scroll-body"],
    });
  }

  /* -------------------------------------------- */
  /**
   * @override
   * Activate event listeners using the prepared sheet HTML
   * @param html {HTMLElement}   The prepared HTML object ready to be rendered into the DOM
   */
  activateListeners(html: JQuery) {
    super.activateListeners(html);

    // Enable collapse triggers.
    initializeCollapses(html);
    applyCollapseListeners(html);

    // Enable any action grid buttons.
    this._activateActionGridListeners(html);

    // Make generic refs clickable to open the item
    handleRefClickOpen(html);

    // Enable ref dragging
    handleRefDragging(html);

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;

    // All-actor macros
    this._activateFlowListeners(html);

    // All-actor macro dragging
    this._activateMacroDragging(html);

    // Make +/- buttons work
    handleInputPlusMinusButtons(html, this.actor);

    // Make counter pips work
    handleCounterInteraction(html, this.actor);

    // Enable hex use triggers.
    handleUsesInteraction(html, this.actor);

    // Enable power use triggers.
    handlePowerUsesInteraction(html, this.actor);

    // Enable context menu triggers.
    handleContextMenus(html, this.actor);

    // Enable viewing inventory on sheets that support it
    this._activateInventoryButton(html);

    // Make refs droppable, in such a way that we take ownership when dropped
    handleRefSlotDropping(html, this.actor, x => this.quickOwnDrop(x).then(v => v[0]));

    // Enable general controls, so items can be deleted and such
    handleGenControls(html, this.actor);

    // Enable popout editors
    handlePopoutTextEditor(html, this.actor);

    // Add export button.
    addExportButton(this.object, html);

    // Add root dropping
    handleDocDropping(
      html,
      async (entry, _dest, _event) => this.onRootDrop(entry, _event, _dest),
      (entry, _dest, _event) => this.canRootDrop(entry)
    );
  }

  _activateMacroDragging(html: JQuery) {
    const ActionMacroHandler = (e: DragEvent) => this._onDragActivationChipStart(e);
    const EncodedMacroHandler = (e: DragEvent) => this._onDragEncodedMacroStart(e);

    html
      .find('li[class*="item"]')
      .add('span[class*="item"]')
      .add('[class*="lancer-macro"]')
      .each((_i, item) => {
        if (item.classList.contains("inventory-header")) return;
        item.setAttribute("draggable", "true");
        if (item.classList.contains("lancer-macro")) {
          item.addEventListener("dragstart", EncodedMacroHandler, false);
          return;
        }
        if (item.classList.contains("activation-chip")) item.addEventListener("dragstart", ActionMacroHandler, false);
        if (item.classList.contains("item"))
          item.addEventListener(
            "dragstart",
            (ev: any) => {
              this._onDragStart(ev);
            },
            false
          );
      });
  }

  _onDragEncodedMacroStart(e: DragEvent) {
    // For macros with encoded data
    e.stopPropagation();

    let encoded = (<HTMLElement>e.currentTarget).getAttribute("data-macro");

    if (!encoded) throw Error("No macro data available");

    let data = JSON.parse(decodeURI(window.atob(encoded)));
    e.dataTransfer?.setData("text/plain", JSON.stringify(data));
  }

  async _activateActionGridListeners(html: JQuery) {
    let elements = html.find(".lancer-action-button");
    elements.on("click", async ev => {
      ev.stopPropagation();

      if (game.user?.isGM || getActionTrackerOptions().allowPlayers) {
        const params = ev.currentTarget.dataset;
        const action = params.action as ActionType | undefined;
        const data = await this.getData();
        if (action && params.val) {
          let spend: boolean;
          if (params.action === "move") {
            spend = parseInt(params.val) > 0;
          } else {
            spend = params.val === "true";
          }
          modAction(data.actor, spend, action);
        }
      } else {
        console.log(`${game.user?.name} :: Users currently not allowed to toggle actions through action manager.`);
      }
    });
  }

  _activateFlowListeners(html: JQuery) {
    // Encoded macros
    let encMacros = html.find(".lancer-macro");
    encMacros.on("click", ev => {
      ev.stopPropagation(); // Avoids triggering parent event handlers
      runEncodedMacro(ev.currentTarget);
    });

    // Basic flow buttons
    let actorFlows = html.find(".lancer-flow-button");
    actorFlows.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();
      console.log("Lancer Flow Button");
      // Check data-flow-type to pick which flow to trigger
      const flowElement = $(ev.currentTarget).closest("[data-flow-type]")[0] as HTMLElement;
      const flowType = flowElement.dataset.flowType;
      const flowArgs = JSON.parse(flowElement.dataset.flowArgs ?? "{}");
      switch (flowType) {
        case "FullRepair":
          this.actor.beginFullRepairFlow(flowArgs?.title ?? undefined);
        case "Stabilize":
          break;
        case "Overheat":
          this.actor.beginOverheatFlow();
          break;
        case "Structure":
          this.actor.beginStructureFlow();
          break;
        case "Overcharge":
          this.actor.beginOverchargeFlow();
          break;
        case "BasicAttack":
          this.actor.beginBasicAttackFlow(flowArgs?.title ?? undefined);
          break;
        case "TechAttack":
          this.actor.beginBasicTechAttackFlow(flowArgs?.title ?? undefined);
          break;
      }
    });

    // Stat rollers
    let statRollers = html.find(".roll-stat");
    statRollers.on("click", ev => {
      ev.stopPropagation(); // Avoids triggering parent event handlers
      const el = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;

      const statPath = el.dataset.path;
      if (!statPath) throw Error("No stat path found!");

      const actor = this.actor as LancerActor;
      actor.beginStatFlow(statPath);
    });

    // Weapon rollers
    let weaponRollers = html.find(".roll-attack");
    weaponRollers.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();

      const weaponElement = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
      const weaponId = weaponElement.dataset.uuid;
      const weapon = LancerItem.fromUuidSync(weaponId ?? "", `Invalid weapon ID: ${weaponId}`);
      weapon.beginWeaponAttackFlow();
    });

    let techRollers = html.find(".roll-tech");
    techRollers.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();

      const techElement = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
      const techId = techElement.dataset.uuid;
      const techItem = LancerItem.fromUuidSync(techId ?? "", `Invalid weapon ID: ${techId}`);
      techItem.beginTechAttackFlow();
    });

    let itemFlows = html.find(".chat-flow-button");
    itemFlows.on("click", async ev => {
      ev.stopPropagation(); // Avoids triggering parent event handlers
      const el = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
      if (!el || !el.dataset.uuid) throw Error(`No item UUID found!`);
      const item = await LancerItem.fromUuid(el.dataset.uuid);
      if (!item) throw Error(`UUID "${el.dataset.uuid}" does not resolve to an item!`);
      beginItemChatFlow(item, el.dataset);
    });
    // TODO: For sanity's sake, merge these into a single "macro" handler
    // Trigger rollers
    // let itemMacros = html
    //   .find(".skill-macro")
    //   // System rollers
    //   .add(html.find(".system-macro"))
    //   // Gear rollers
    //   .add(html.find(".gear-macro"))
    //   // Core bonus
    //   .add(html.find(".cb-macro"))
    //   // Reserve
    //   .add(html.find(".reserve-macro"));
    // itemMacros.on("click", (ev: any) => {
    //   ev.stopPropagation(); // Avoids triggering parent event handlers

    //   const el = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
    //   prepareItemMacro(el.dataset.uuid!);
    // });

    let skillFlows = html.find(".skill-flow");
    skillFlows.on("click", ev => {
      ev.stopPropagation(); // Avoids triggering parent event handlers

      const el = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
      const skillId = el.dataset.uuid;
      const skill = LancerItem.fromUuidSync(skillId ?? "", `Invalid skill ID: ${skillId}`);
      skill.beginSkillFlow();
    });

    // Bond Power flow
    let powerFlows = html.find(".bond-power-flow");
    powerFlows.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();

      const powerElement = $(ev.currentTarget).closest("[data-uuid]")[0] as HTMLElement;
      const bondId = powerElement.dataset.uuid;
      const bond = LancerItem.fromUuidSync(bondId ?? "", `Invalid bond ID: ${bondId}`);
      const powerIndex = parseInt(powerElement.dataset.powerIndex ?? "-1");
      bond.beginBondPowerFlow(powerIndex);
    });

    // Bond XP
    let bondXp = html.find(".bond-xp-button");
    bondXp.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();

      const actor = this.actor as LancerActor;
      if (!actor.is_pilot() || !actor.system.bond) return;
      actor.tallyBondXP();
    });

    // Refresh Bond powers
    let bondRefresh = html.find(".refresh-powers-button");
    bondRefresh.on("click", ev => {
      if (!ev.currentTarget) return; // No target, let other handlers take care of it.
      ev.stopPropagation();

      const actor = this.actor as LancerActor;
      if (!actor.is_pilot() || !actor.system.bond) return;
      actor.system.bond.refreshPowers();
    });

    // Non-action system use flows
    html.find(".effect-flow").on("click", ev => {
      ev.stopPropagation();
      const el = ev.currentTarget.closest("[data-uuid]") as HTMLElement;
      const itemId = el.dataset.uuid;
      const item = LancerItem.fromUuidSync(itemId ?? "", `Invalid item ID: ${itemId}`);
      item.beginSystemFlow();
    });

    // Action-chip flows
    html.find(".activation-flow").on("click", ev => {
      ev.stopPropagation();

      const el = ev.currentTarget;

      const itemId = el.dataset.uuid;
      const path = el.dataset.path;
      if (!itemId || !path) throw Error("No item ID from activation chip");

      let isDeployable = path.includes("deployable");
      let isAction = !isDeployable && path.includes("action");
      let isCoreSystem = !isDeployable && path.includes("core_system");

      const item = LancerItem.fromUuidSync(itemId ?? "", `Invalid item ID: ${itemId}`);
      if (isAction) {
        item.beginActivationFlow(path);
      } else if (isCoreSystem) {
        item.beginCoreActiveFlow(path);
      } else if (isDeployable) {
      } else {
        ui.notifications!.error("Could not infer action type");
      }
    });

    let ChargeMacro = html.find(".charge-macro");
    ChargeMacro.on("click", ev => {
      ev.stopPropagation(); // Avoids triggering parent event handlers

      prepareChargeMacro(this.actor);
    });
  }

  _onDragActivationChipStart(event: DragEvent) {
    // For talent macros
    event.stopPropagation(); // Avoids triggering parent event handlers

    let target = <HTMLElement>event.currentTarget;

    let title = target.closest(".action-wrapper")?.querySelector(".action-title")?.textContent;
    let itemId = target.closest("[data-uuid]")?.getAttribute("data-uuid");

    if (!itemId) throw Error("No item found");

    title = title ?? this.actor.items.get(itemId)?.name ?? "unknown activation";

    let a = target.getAttribute("data-activation");
    let d = target.getAttribute("data-deployable");

    let activationOption: ActivationOptions;
    let activationIndex: number;
    if (a) {
      const activation = parseInt(a);
      activationOption = ActivationOptions.ACTION;
      activationIndex = activation;
    } else if (d) {
      const deployable = parseInt(d);
      activationOption = ActivationOptions.DEPLOYABLE;
      activationIndex = deployable;
    } else {
      throw Error("unknown activation was dragged.");
    }

    // send as a generated macro:
    let macroData: LancerFlowState.InvocationData = {
      iconPath: `systems/${game.system.id}/assets/icons/macro-icons/mech_system.svg`,
      title: title!,
      fn: "prepareActivationMacro",
      args: [itemId, activationOption, activationIndex],
    };

    event.dataTransfer?.setData("text/plain", JSON.stringify(macroData));
  }

  getStatPath(event: any): string | null {
    if (!event.currentTarget) return null;
    // Find the stat input to get the stat's key to pass to the macro function
    let el = $(event.currentTarget).closest(".stat-container").find(".lancer-stat")[0] as HTMLElement;

    if (!el) el = $(event.currentTarget).siblings(".lancer-stat")[0];

    if (el.nodeName === "INPUT") {
      return (<HTMLInputElement>el).name;
    } else if (el.nodeName === "DATA") {
      return (<HTMLDataElement>el).id;
    } else if (el.nodeName === "SPAN") {
      return (<HTMLSpanElement>el).getAttribute("data-path");
    } else {
      throw "Error - stat macro was not run on an input or data element";
    }
  }

  /**
   * Handles inventory button
   */
  _activateInventoryButton(html: any) {
    let button = html.find(".inventory button");

    button.on("click", async (ev: Event) => {
      ev.preventDefault();
      return InventoryDialog.show_inventory(this.actor as LancerActor);
    });
  }

  // A grand filter that pre-decides if we can drop an item ref anywhere within this sheet. Should be implemented by child sheets
  // We generally assume that a global item is droppable if it matches our types, and that an owned item is droppable if it is owned by this actor
  // This is more of a permissions/suitability question
  canRootDrop(_item: ResolvedDropData): boolean {
    return false;
  }

  // This function is called on any dragged item that percolates down to root without being handled
  // Override/extend as appropriate
  async onRootDrop(_item: ResolvedDropData, _event: JQuery.DropEvent, _dest: JQuery<HTMLElement>): Promise<void> {}

  // Override base behavior
  protected _createDragDropHandlers(): DragDrop[] {
    return [];
  }

  // Makes us own (or rather, creates an owned copy of) the provided item if we don't already.
  // The second return value indicates whether a new copy was made (true), or if we already owned it/it is an actor (false)
  // Note: this operation also fixes limited to be the full capability of our actor
  async quickOwn(document: LancerItem): Promise<[LancerItem, boolean]> {
    if (document.parent != this.actor) {
      let results = await insinuate([document], this.actor);
      for (let newItem of results) {
        if (newItem.isLimited()) {
          await newItem.update({
            "system.uses.value": newItem.system.uses.max,
          });
        }
      }
      return [results[0], true];
    } else {
      // Its already owned
      return [document, false];
    }
  }

  // As quick_own, but for any drop. Maintains drop structure, since not necessarily guaranteed to have made an item
  async quickOwnDrop(drop: ResolvedDropData): Promise<[ResolvedDropData, boolean]> {
    if (drop.type == "Item") {
      let [document, new_] = await this.quickOwn(drop.document);
      return [
        {
          type: "Item",
          document,
        },
        new_,
      ];
    } else {
      return [drop, false];
    }
  }

  _propagateData(formData: any): any {
    // Pushes relevant field data from the form to other appropriate locations,
    // e.x. to synchronize name between token and actor
    // @ts-expect-error should be fixed and not need the "as" with v10 types
    let token = this.actor.prototypeToken as PrototypeTokenData;

    if (!token) {
      // Set the prototype token image if the prototype token isn't initialized
      formData["prototypeToken.texture.src"] = formData["img"];
      formData["prototypeToken.name"] = formData["name"];
    } else {
      // Update token image if it matches the old actor image - keep in sync
      // @ts-expect-error
      if (this.actor.img === token.texture.src && this.actor.img !== formData["img"]) {
        formData["prototypeToken.texture.src"] = formData["img"];
      }
      // Ditto for name
      if (this.actor.name === token["name"] && this.actor.name !== formData["name"]) {
        formData["prototypeToken.name"] = formData["name"];
      }
    }
  }

  /**
   * Implement the _updateObject method as required by the parent class spec
   * This defines how to update the subject of the form when the form is submitted
   * @private
   */
  async _updateObject(_event: Event, formData: any): Promise<LancerActor | undefined> {
    // Automatically propagates changes to image/name
    this._propagateData(formData);

    // Simple writeback
    await this.actor.update(formData);

    return this.actor;
  }

  /**
   * Prepare data for rendering the Actor sheet
   * The prepared data object contains both the actor data as well as additional sheet options
   */
  async getData(): Promise<LancerActorSheetData<T>> {
    const data = await super.getData(); // Not fully populated yet!
    data.collapse = {};
    // @ts-expect-error
    data.system = this.actor.system; // Alias
    data.itemTypes = this.actor.itemTypes;
    data.effect_categories = LancerActiveEffect.prepareActiveEffectCategories(this.actor);
    data.deployables = lookupOwnedDeployables(this.actor);
    console.log(`${lp} Rendering with following actor ctx: `, data);
    return data;
  }
}
