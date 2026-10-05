import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { branches } from "../../shared/types";
import { ItemDto } from "../orders/orders.dto";
import { receiptMethods } from "../../shared/admin-accounting";
import { approvalTypes } from "../../shared/admin-approval";
import { salesDeliveries, salesPayments, salesSources } from "../../shared/admin-sales";

export const actions = ["save-order", "advance-order", "cancel-order", "create-approval", "decide-approval", "customer-status", "publish-product", "pick-item", "report-shortage", "resolve-shortage", "create-receipt", "reconcile-receipt", "void-receipt", "due-date"] as const;
export class AdminCommandDto {
  @IsIn(actions) action!: typeof actions[number];
  @IsIn(branches) branch!: typeof branches[number];
  @IsOptional() @IsString() @Length(1, 100) id?: string;
  @IsObject() payload!: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(1) expectedRevision?: number;
}
export class DetailsDto {
  @IsString() @Length(1, 100) recipient!: string;
  @IsString() @Length(9, 20) phone!: string;
  @IsString() @MaxLength(300) address!: string;
  @IsIn(salesDeliveries) delivery!: typeof salesDeliveries[number];
  @IsIn(salesPayments) payment!: typeof salesPayments[number];
  @IsString() @MaxLength(500) note!: string;
}
export class SalesDto {
  @IsString() @MaxLength(100) customerId!: string;
  @IsString() @Length(1, 100) source!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
  @IsDefined() @ValidateNested() @Type(() => DetailsDto) details!: DetailsDto;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class ApprovalDto {
  @IsIn(approvalTypes) type!: typeof approvalTypes[number];
  @IsString() @Length(1, 500) reason!: string;
  @IsObject() prices!: Record<string, number>;
}
export class ReasonDto { @IsString() @Length(1, 500) reason!: string; }
export class DecisionDto extends ReasonDto { @IsBoolean() approved!: boolean; }
export class StatusDto { @IsIn(["Chờ duyệt", "Đang hoạt động", "Tạm ngưng"]) status!: "Chờ duyệt" | "Đang hoạt động" | "Tạm ngưng"; }
export class PublishDto { @IsBoolean() published!: boolean; }
export class PickDto { @IsString() @Length(1, 100) productId!: string; @IsBoolean() picked!: boolean; }
export class ShortageDto { @IsString() @Length(1, 100) productId!: string; @IsInt() @Min(1) @Max(999) quantity!: number; @IsString() @Length(1, 500) note!: string; }
export class NoteDto { @IsString() @Length(1, 500) note!: string; }
export class ReceiptDto {
  @IsString() @Length(1, 100) orderId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount!: number;
  @IsIn(receiptMethods) method!: typeof receiptMethods[number];
  @IsString() @Length(10, 10) date!: string;
  @IsString() @Length(1, 100) reference!: string;
  @IsString() @MaxLength(500) note!: string;
}
export class ReconcileDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount!: number;
  @IsString() @Length(1, 100) reference!: string;
  @IsString() @Length(1, 500) note!: string;
}
export class DueDto { @IsString() @Length(10, 10) date!: string; }
