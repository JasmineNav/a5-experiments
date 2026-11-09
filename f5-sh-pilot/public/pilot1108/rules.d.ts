export const fields: readonly ['qualified', 'A', 'B', 'C', 'D'];
export function feeFilled(value: unknown): boolean;
export function planSelection(value: unknown): string[] | null;
export function filledState(answers: Record<typeof fields[number], string>): Record<typeof fields[number], boolean>;
export const progressModes: readonly ['substeps-v1', 'substeps-v2'];
export function isSubstepProgress(mode: unknown): boolean;
export function taskProgress(stage: string, answers: Record<typeof fields[number], string>, mode?: 'substeps-v1' | 'substeps-v2'): {
  mode: string; value: number; filled: Record<typeof fields[number], boolean>; completed: number;
  submitted: boolean; means_correct: boolean;
};
