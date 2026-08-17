import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function notFound(_request: Request, _response: Response, next: NextFunction) {
  next(new HttpError(404, "Route not found"));
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
) {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "ValidationError",
      message: "Invalid request payload",
      details: error.flatten()
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: "HttpError",
      message: error.message
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    response.status(400).json({
      error: "UploadError",
      message: uploadErrorMessage(error)
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    error: "InternalServerError",
    message: "Unexpected server error"
  });
}

function uploadErrorMessage(error: multer.MulterError) {
  if (error.code === "LIMIT_FILE_SIZE") {
    return "One evidence file exceeds the maximum allowed size.";
  }

  if (error.code === "LIMIT_FILE_COUNT") {
    return "Too many evidence files were uploaded. The current limit is 10 files.";
  }

  if (error.code === "LIMIT_UNEXPECTED_FILE") {
    return "Unexpected upload field. Evidence files must be uploaded with the documents field.";
  }

  return error.message || "Evidence upload failed.";
}
