import { IsIn } from "class-validator";
import { branches } from "../types/domain.types";

export class ProductEditorQueryDto {
  @IsIn(branches) branch!: typeof branches[number];
}
