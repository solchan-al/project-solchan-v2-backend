import { Router, type NextFunction } from "express";
import { z } from "zod";

import { HttpError } from "../http/errors.js";
import { upload } from "../http/upload.js";
import { WalletAddressSchema } from "../schemas/common.js";
import { sha256File } from "../services/hash.js";
import { storeImageAsset } from "../services/storage.js";

export const assetRouter = Router();

assetRouter.post("/images", upload.single("image"), async (request, response, next: NextFunction) => {
  const BodySchema = z.object({
    owner: z.string().min(1).max(160),
    uploadedByWallet: WalletAddressSchema.optional()
  });

  try {
    const parsed = BodySchema.parse(request.body);
    const file = request.file;

    if (!file) {
      throw new HttpError(400, "Image file is required.");
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new HttpError(400, "Only image uploads are accepted on this endpoint.");
    }

    const stored = await storeImageAsset(file.path, parsed.owner, file.originalname);
    const hash = await sha256File(stored.absolutePath);

    response.status(201).json({
      asset: {
        byteSize: file.size,
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        sha256Hash: hash,
        storagePath: stored.storagePath,
        uploadedByWallet: parsed.uploadedByWallet ?? null,
        url: `/storage/${stored.storagePath}`
      }
    });
  } catch (error) {
    next(error);
  }
});
