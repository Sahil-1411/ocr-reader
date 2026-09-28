/**
 * Constants the OpenCV.js typings omit.
 *
 * `@techstark/opencv-js` generates its `.d.ts` files from the OpenCV headers,
 * and a few enums do not survive that pass — `ReduceTypes` among them. The
 * values are present at runtime; only the declarations are missing, so
 * `cv.REDUCE_SUM` is a type error even though it evaluates correctly.
 *
 * Rather than cast `cv` to `any` at the call site and lose type checking on the
 * surrounding arguments, the values are named here. They are part of OpenCV's
 * published ABI and have been stable since 2.x, so hard-coding them is safe;
 * each one is cited to the header it comes from.
 */

/** `ReduceTypes` — modules/core/include/opencv2/core.hpp */
export const REDUCE_SUM = 0
export const REDUCE_AVG = 1
export const REDUCE_MAX = 2
export const REDUCE_MIN = 3

/** Axis argument to `cv.reduce`. */
export const REDUCE_TO_SINGLE_ROW = 0
export const REDUCE_TO_SINGLE_COLUMN = 1
