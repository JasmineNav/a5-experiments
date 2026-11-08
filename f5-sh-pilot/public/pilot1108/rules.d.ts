export const fields: readonly ['qualified', 'A', 'B', 'C', 'D'];
export function feeFilled(value: unknown): boolean;
export function planSelection(value: unknown): string[] | null;
export function filledState(answers: Record<typeof fields[number], string>): Record<typeof fields[number], boolean>;
