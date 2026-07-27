import type { NextFunction, Request, Response } from "express";
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

  console.error(error);
  response.status(500).json({
    error: "InternalServerError",
    message: "Unexpected server error"
  });
}

