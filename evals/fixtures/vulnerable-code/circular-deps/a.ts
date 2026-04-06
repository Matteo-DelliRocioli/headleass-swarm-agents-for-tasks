import { processB } from "./b.js";

export interface EntityA {
  id: string;
  name: string;
  relatedB?: string;
}

export function processA(data: EntityA): string {
  if (data.relatedB) {
    return processB({ id: data.relatedB, value: 0, sourceA: data.id });
  }
  return `processed-a:${data.id}`;
}
