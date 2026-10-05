import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { DatabaseService } from "./database/database.service";
import { SeedService } from "./database/seed.service";
import { CatalogController } from "./catalog/catalog.controller";
import { OrdersController } from "./orders/orders.controller";
import { OrdersService } from "./orders/orders.service";
import { AdminController } from "./admin/admin.controller";
import { AdminService } from "./admin/admin.service";
import { AccountController } from "./account/account.controller";
import { MediaController } from "./media/media.controller";
import { HealthController } from "./health.controller";
import { ContactController } from "./contact/contact.controller";

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32 || secret.startsWith("replace-")) throw new Error("JWT_SECRET must contain at least 32 random characters.");
    return { secret };
  } }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 240 }])],
  controllers: [AuthController, CatalogController, OrdersController, AdminController, AccountController, MediaController, HealthController, ContactController],
  providers: [DatabaseService, SeedService, AuthService, OrdersService, AdminService, { provide: APP_GUARD, useClass: ThrottlerGuard }]
})
export class AppModule {}
