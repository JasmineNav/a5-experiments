export const fields: readonly ['qualified', 'A', 'B', 'C', 'D'];
export function feeFilled(value: unknown): boolean;
export function planSelection(value: unknown): string[] | null;
export function filledState(answers: Record<typeof fields[number], string>): Record<typeof fields[number], boolean>;
export function taskProgress(stage: string, answers: Record<typeof fields[number], string>): {
  mode: string; value: number; filled: Record<typeof fields[number], boolean>; completed: number;
  submitted: boolean; means_correct: boolean;
};
