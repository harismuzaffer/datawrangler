import { columnTransforms } from "./columns";
import type { Transform } from "./core";
import { rowTransforms } from "./rows";
import { textTransforms } from "./text";
import { valueTransforms } from "./values";

export { createContext, StepError, type Change, type StepResult } from "./core";

/** Every transform a pipeline step can use, by name. */
export const TRANSFORMS = {
  ...textTransforms,
  ...valueTransforms,
  ...rowTransforms,
  ...columnTransforms
} satisfies Record<string, Transform>;

export type TransformName = keyof typeof TRANSFORMS;

export const TRANSFORM_NAMES = Object.keys(TRANSFORMS) as [
  TransformName,
  ...TransformName[]
];

export function isTransformName(name: string): name is TransformName {
  return Object.hasOwn(TRANSFORMS, name);
}
