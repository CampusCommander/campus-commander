import type {
  UserAttributeCategory,
  UserCustomSchemas,
} from '@campus/application-contracts';

/** One attribute of the read-only Custom attributes card. */
export interface UserAttributeValue {
  fieldName: string;
  /** The attribute display name, or the raw field key when the category read failed. */
  label: string;
  /** The values in order. Empty when the attribute holds no value. */
  values: string[];
  /** A multi-valued attribute shows its values as static chips (UM notes composition 1). */
  multiValued: boolean;
}

/** One category section of the read-only Custom attributes card (A section 9). */
export interface UserAttributeSection {
  schemaName: string;
  displayName: string;
  /**
   * The attributes of a category that holds at least one value. An empty list means
   * the section shows one line, "No values set" (UM notes composition 2).
   */
  values: UserAttributeValue[];
}

/** The values of one attribute: a scalar, or a list of `{ value }` entries. */
export function attributeValues(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value)
    ? value.map((item) =>
        item !== null && typeof item === 'object' && 'value' in item
          ? (item as { value: unknown }).value
          : item,
      )
    : [value];
}

/** The display text of one value: a boolean reads as Yes or No. */
export function valueText(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
}

/**
 * The raw value of one attribute. Only own properties hold a value, so a category or
 * field named after an Object prototype member reads as unset (R12).
 */
function readValue(
  schemas: UserCustomSchemas,
  schemaName: string,
  fieldName: string,
): unknown {
  const category = Object.hasOwn(schemas, schemaName)
    ? schemas[schemaName]
    : undefined;
  return category &&
    typeof category === 'object' &&
    Object.hasOwn(category, fieldName)
    ? (category as Record<string, unknown>)[fieldName]
    : undefined;
}

/** One section. A category without a value shows the one line of composition 2. */
function section(
  schemas: UserCustomSchemas,
  schemaName: string,
  displayName: string,
  fields: readonly {
    fieldName: string;
    label: string;
    multiValued?: boolean;
  }[],
): UserAttributeSection {
  const values = fields.map((field): UserAttributeValue => {
    const items = attributeValues(
      readValue(schemas, schemaName, field.fieldName),
    ).map(valueText);
    return {
      fieldName: field.fieldName,
      label: field.label,
      values: items,
      // A raw key carries no metadata, so more than one value reads as a list.
      multiValued: field.multiValued ?? items.length > 1,
    };
  });
  return {
    schemaName,
    displayName,
    values: values.every((value) => value.values.length === 0) ? [] : values,
  };
}

/**
 * The card sections of one user: one section for each category that the customer holds,
 * in the order of the category read (A section 9).
 */
export function userAttributeSections(
  categories: readonly UserAttributeCategory[],
  schemas: UserCustomSchemas,
): UserAttributeSection[] {
  return categories.map((category) =>
    section(
      schemas,
      category.schemaName,
      category.displayName,
      category.fields.map((field) => ({
        fieldName: field.fieldName,
        label: field.displayName,
        multiValued: field.multiValued,
      })),
    ),
  );
}

/**
 * The raw category and attribute keys, for a user read without the category read
 * (A section 11, "Missing Google scope").
 */
export function rawAttributeSections(
  schemas: UserCustomSchemas,
): UserAttributeSection[] {
  return Object.keys(schemas).map((schemaName) => {
    const category: unknown = schemas[schemaName];
    const fields =
      category && typeof category === 'object' && !Array.isArray(category)
        ? Object.keys(category as Record<string, unknown>)
        : [];
    return section(
      schemas,
      schemaName,
      schemaName,
      fields.map((fieldName) => ({ fieldName, label: fieldName })),
    );
  });
}
