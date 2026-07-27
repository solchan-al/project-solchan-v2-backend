import multer from "multer";

import { env } from "../config/env.js";
import { HttpError } from "./errors.js";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
  "application/json"
]);

export const upload = multer({
  dest: "storage/tmp",
  limits: {
    fileSize: env.MAX_UPLOAD_BYTES,
    files: 10
  },
  fileFilter: (_request, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new HttpError(400, `Unsupported file type: ${file.mimetype}`));
      return;
    }
    callback(null, true);
  }
});

