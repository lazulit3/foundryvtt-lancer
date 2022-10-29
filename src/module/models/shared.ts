import { boolean } from "io-ts";
import { LancerActor } from "../actor/lancer-actor";
import { EntryType } from "../enums";
import { format_dotpath } from "../helpers/commons";
import { LancerItem } from "../item/lancer-item";
import { SystemTemplates } from "../system-template";

// @ts-ignore
const fields: any = foundry.data.fields;

const EMBEDDED_REF_WIP_MARKER = Symbol("EMBEDDED_REF_FIELD_MARKER");

// @ts-expect-error
export class LancerDataModel<T> extends foundry.abstract.DataModel<T> {
  // For you, sohum. Svelte it to your heart's content

  /**
   * A more sophisticated mergeobject
   * @param update_data the update data to apply
   */
  full_update_data(update_data: object): object {
    // @ts-expect-error
    let system = this.toObject();
    return fancy_merge_data({ system }, update_data);
  }
}

/**
 * Merge data, except it handles arrays.
 *
 */
export function fancy_merge_data(full_source_data: any, update_data: any): any {
  if (full_source_data == null) throw new Error("Cannot merge with null or undefined - try again");
  for (let [k, v] of Object.entries(update_data)) {
    // Prepare for dotpath traversal
    k = format_dotpath(k);

    // Detect deletes
    let del = k.startsWith("-=");
    if (del) {
      k = k.slice(2);
    }

    // Detect dots
    let di = k.indexOf(".");
    if (di != -1) {
      if (del) {
        throw new Error("'-=' in dotpath must go at penultimate pathlet. E.x. 'system.whatever.-=val'");
      }

      // Dotpath - go recursive on that key
      let fore = k.slice(0, di);
      let aft = k.slice(di + 1);

      // Find existing value and branch on its existence
      let prior = full_source_data[fore];
      if (prior) {
        // Recursive
        fancy_merge_data(prior, { [aft]: v });
      } else {
        // New value at this location
        full_source_data[fore] = { [aft]: v };
      }
    } else {
      // Not a dotpath - assign/delete directly. Fairly trivial
      if (del) {
        if (Array.isArray(full_source_data)) {
          // Splice it
          full_source_data.splice(parseInt(k), 1);
        } else if (typeof full_source_data == "object") {
          // Delete it
          delete full_source_data[k];
        } else {
          // Unhandled type or nonexistant val
          console.warn("'-=' in update may only target Object or Array items");
        }
      } else {
        // Just assign it - simple as
        full_source_data[k] = v;
      }
    }
  }
  return full_source_data;
}

// Use this for all LIDs, to ensure consistent formatting
export class LIDField extends fields.StringField {
  /** @override */
  _cast(value: any) {
    if (value.lid) value = value.lid;
    if (value.system?.lid) value = value.system.lid;
    if (typeof value === "string") return value;
    throw new Error("Not a string or LID-posessing item: " + value);
  }
}

export class ResolvedEmbeddedRefField extends fields.StringField {
  allowed_types: EntryType[] | null;

  /**
   * @param {StringFieldOptions} options  Options which configure the behavior of the field
   */
  constructor(
    readonly embedded_collection: "Item" | "ActiveEffect",
    options: { allowed_types?: EntryType[] } & Record<string, any> = {}
  ) {
    super(options);
    this.allowed_types = options.allowed_types ?? null;
  }

  /** @inheritdoc */
  static get _defaults() {
    return mergeObject(super._defaults, {
      initial: null,
      blank: false,
      trim: true,
      nullable: true,
    });
  }

  /** @override */
  _cast(value: any) {
    if (value?.id) {
      value = value.id;
    }
    return String(value);
  }

  /** @inheritdoc */
  initialize(value: string, model: any): null | SystemTemplates.ResolvedEmbeddedRef<any> {
    if (value != null) {
      let sub = model?.parent?.getEmbeddedDocument(this.embedded_collection, value);
      if (!sub) {
        console.log("Failed to resolve embedded ref: ID not found.", model, value);
        return {
          status: "missing",
          value: null,
        };
      } else if (this.allowed_types && !this.allowed_types.includes(sub.type)) {
        console.log(
          `Failed to resolve embedded ref: Wrong type ${sub.type} not in ${this.allowed_types.join("|")}`,
          model,
          value
        );
        return {
          status: "missing",
          value: null,
        };
      } else {
        return {
          status: "resolved",
          value: sub,
        };
      }
    } else {
      return value;
    }
  }
}

// Similar to the foreignDocumentField, except untyped and supports uuids
// Supports both sync and async lookup
export class ResolvedUUIDRefField extends fields.StringField {
  // The acceptable document.type's for this to resolve to
  // Null is wildcard
  accepted_types: string[] | null;

  constructor(accepted_types?: string[], options = {}) {
    super(options);
    this.accepted_types = accepted_types ?? null;
  }

  /** @inheritdoc */
  static get _defaults() {
    return mergeObject(super._defaults, {
      required: true,
      blank: false,
      nullable: true,
      initial: null,
      readonly: true,
      validationError: "is not a valid Document UUID string",
    });
  }

  /** @override */
  _cast(value: any) {
    if (typeof value == "object" && value.uuid) {
      //
      return value.uuid;
    } else if (value === null) {
      return value;
    } else {
      return String(value);
    }
  }

  /** @override */
  _validateType(value: string | null) {
    try {
      if (value) {
        //@ts-expect-error  Missing type
        _parseUuid(value);
        return true; // A definitive success
      }
    } catch (e) {
      throw new Error("Not a valid uuid");
    }
  }

  /** @inheritdoc */
  initialize(model: unknown, name: string, value: string | null) {
    // if ( this.idOnly ) return value;
    // if ( !game.collections ) return value; // server-side
    let rv = {
      uuid: value,
      doc_async: () => (value ? fromUuid(value) : null),
    };
    Object.defineProperty(rv, "doc_sync", {
      get: () => {
        //@ts-expect-error missing type
        let v = fromUuidSync(value);
        if (!(v instanceof foundry.abstract.Document)) {
          v = null; // It was a compendium reference. Stinky!
        }
        return v;
      },
      set() {}, // no-op
      configurable: false,
    });
    return rv;
  }
}

// Use this to represent a field that is effectively just a number, but should present as a min/max/value field in expanded `system` data
export class FakeBoundedNumberField extends fields.NumberField {
  /** @override */
  initialize(model: unknown, name: string, value: number) {
    // Expand to a somewhat reasonable range. `prepareData` functions should handle the rest
    return {
      min: 0,
      max: value || 1,
      value,
    };
  }

  /** @override */
  _cast(value: any) {
    if (typeof value == "object") {
      value = value.value ?? 0;
    }
    return super._cast(value);
  }
}
