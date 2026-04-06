import { processA } from "./a.js";

export interface EntityC {
  id: string;
  category: string;
  originB?: string;
}

export function processC(data: EntityC): string {
  // CIRCULAR: c.ts imports a.ts which imports b.ts which imports c.ts
  if (data.category === "special") {
    return processA({ id: data.id, name: data.category });
  }
  return `processed-c:${data.id}`;
}
