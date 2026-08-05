import type { FastifyError } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'

import { ConflictError, InputError } from '@agents-board/core'

/**
 * Single place that turns a thrown error into an HTTP response, so routes can
 * stay thin and just let the core throw. The `error` field is always a string
 * message (consistent with the existing 404 shape); validation failures carry
 * an `issues` array, and a `code` discriminates the kind.
 */
export default fp(async (app) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Zod validation, raised either at the API edge (querystrings) or inside
    // the core use-cases that `.parse()` their input.
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Request validation failed',
        code: 'validation_error',
        issues: err.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message
        }))
      })
    }

    // Business-rule violation flagged by the core (e.g. unknown reference,
    // illegal hierarchy move).
    if (err instanceof InputError) {
      return reply.code(400).send({ error: err.message, code: 'invalid_input' })
    }

    // Well-formed request that conflicts with current state (e.g. last admin).
    if (err instanceof ConflictError) {
      return reply.code(409).send({ error: err.message, code: 'conflict' })
    }

    // Fastify's own schema validation, if any route ever declares one.
    if (err.validation) {
      return reply.code(400).send({ error: err.message, code: 'validation_error' })
    }

    // Anything else is an unexpected fault: log it and return 500 (instead of
    // the previous behaviour of masking every failure as a 400).
    req.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ error: 'Internal server error', code: 'internal' })
  })
})
