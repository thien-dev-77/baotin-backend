import type { Branch } from "./domain.types";

export type PricePolicy = {
  id: string;
  name: string;
  branch: Branch;
  scope: "default" | "group" | "customer";
  target: string;
  discount: number;
  prices: Record<string, number>;
  startsOn: string;
  endsOn: string | null;
  active: boolean;
  revision: number;
};
