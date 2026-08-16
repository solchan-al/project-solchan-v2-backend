import multer from "multer";

import { env } from "../config/env.js";
import { HttpError } from "./errors.js";

const allowedMimeTypes = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "application/csv",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/markdown",
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
