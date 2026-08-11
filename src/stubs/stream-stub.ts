/**
 * AETERNA stream stub
 *
 * Browser-safe Readable stream placeholder.
 *
 * Used to satisfy Node.js "stream" imports when bundling
 * client runtime with vite-plugin-node-polyfills.
 *
 * This stub intentionally implements no streaming behavior.
 *
 * Compatible with:
 * - Vite
 * - Cloudflare Workers / Pages
 * - Edge runtimes
 * - async iterator consumers
 */

export class Readable {

  static from(_input?: unknown): Readable {

    return new Readable();

  }


  pipe(_destination?: unknown): Readable {

    return this;

  }


  on(
    _event?: string,
    _handler?: (...args: unknown[]) => void
  ): Readable {

    return this;

  }


  destroy(_error?: unknown): Readable {

    return this;

  }


  /**
   * Async iterator compatibility
   *
   * Prevents crashes in libraries expecting:
   * for await (const chunk of stream)
   */

  [Symbol.asyncIterator]() {

    return {

      next: async () => ({

        done: true,

        value: undefined,

      }),

    };

  }

}


/**
 * Default export compatibility:
 *
 * import stream from "stream"
 */

export default {

  Readable,

};