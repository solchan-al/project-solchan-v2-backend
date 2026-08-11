import { Router, type NextFunction } from "express";
import { z } from "zod";

import { pool } from "../db/pool.js";
import { WalletAddressSchema } from "../schemas/common.js";
import { getActorRegistration } from "../services/actor-identity.js";

export const actorRouter = Router();

actorRouter.get("/wallet/:walletAddress", async (request, response, next: NextFunction) => {
  const ParamsSchema = z.object({
    walletAddress: WalletAddressSchema
  });

  try {
    const { walletAddress } = ParamsSchema.parse(request.params);
    const registration = await getActorRegistration(pool, walletAddress);
    response.json({ registration });
  } catch (error) {
    next(error);
  }
});
