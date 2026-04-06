import { processC } from "./c.js";

export interface EntityB {
  id: string;
  value: number;
  sourceA?: string;
}

export function processB(data: EntityB): string {
  if (data.value > 100) {
    return processC({ id: data.id, category: "high", originB: data.id });
  }
  return `processed-b:${data.id}`;
}
