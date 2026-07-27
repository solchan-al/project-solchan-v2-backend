import { z } from "zod";

export const UuidParamsSchema = z.object({
  id: z.string().uuid()
});

export const WalletAddressSchema = z.string().min(32).max(64);
export const OptionalPublicKeySchema = z.string().min(32).max(64).optional();

