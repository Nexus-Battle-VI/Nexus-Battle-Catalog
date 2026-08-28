export interface MongoTestResources {
  readonly client?: { readonly close: () => Promise<unknown> }
  readonly container?: { readonly stop: () => Promise<unknown> }
}

/** Libera los recursos creados por la suite MongoDB. */
export const closeMongoTestResources = async ({
  client,
  container,
}: MongoTestResources): Promise<void> => {
  await Promise.all([client?.close(), container?.stop()])
}
