/** 统一时间源：wall 为墙钟（毫秒时间戳，可持久化、可显示）；mono 为单调时钟（毫秒，仅用于计算间隔，不可持久化）。 */
export interface Clock { wall: () => number; mono: () => number }
/** 生产用系统时钟。 */
export const systemClock: Clock = { wall: () => Date.now(), mono: () => performance.now() };
