class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
const within = (promise, ms = 1000) =>
  Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`timeout after ${ms}ms`)
    }),
  ])

class RefreshModel {
  constructor(variant) {
    this.variant = variant
    this.storage = { refresh_token: 'R1', access_token: 'A1' }
    this.refreshingDeferred = null
    this.notifyingRefreshResult = null
    this.subscribers = []
    this.serviceCalls = 0
    this.subscriberErrors = []
  }

  subscribe(callback) {
    this.subscribers.push(callback)
  }

  async notify(session) {
    const previousResult = this.notifyingRefreshResult
    this.notifyingRefreshResult = { data: session, error: null }
    const errors = []
    try {
      await Promise.all(
        this.subscribers.map(async (callback) => {
          try {
            await callback('TOKEN_REFRESHED', session)
          } catch (error) {
            errors.push(error)
          }
        })
      )
      this.subscriberErrors.push(...errors.map((error) => String(error?.message ?? error)))
    } finally {
      this.notifyingRefreshResult = previousResult
    }
  }

  async refreshSession(currentSession) {
    const token = currentSession?.refresh_token ?? this.storage.refresh_token
    return this.callRefreshToken(token)
  }

  async callRefreshToken(refreshToken) {
    if (this.notifyingRefreshResult?.data?.refresh_token === refreshToken) {
      return this.notifyingRefreshResult
    }

    if (this.refreshingDeferred) {
      return this.refreshingDeferred.promise
    }

    const deferred = new Deferred()
    this.refreshingDeferred = deferred

    try {
      this.serviceCalls += 1
      await nextTurn()

      const session = { refresh_token: 'R2', access_token: 'A2' }
      this.storage = session
      const result = { data: session, error: null }

      if (this.variant === 'early-shared-settlement') {
        deferred.resolve(result)
      }

      await this.notify(session)

      if (this.variant === 'token-aware-committed-result') {
        deferred.resolve(result)
      }

      return result
    } finally {
      this.refreshingDeferred = null
    }
  }
}

async function defaultNested(variant) {
  const model = new RefreshModel(variant)
  let nested = null
  model.subscribe(async () => {
    nested = await model.refreshSession()
  })
  const outer = await within(model.callRefreshToken('R1'))
  return {
    outerToken: outer.data.refresh_token,
    nestedToken: nested.data.refresh_token,
    storedToken: model.storage.refresh_token,
    serviceCalls: model.serviceCalls,
  }
}

async function queuedDefaultNested(variant) {
  const model = new RefreshModel(variant)
  const session = { refresh_token: 'R2', access_token: 'A2' }
  model.storage = session
  model.serviceCalls = 1
  let nested = null
  model.subscribe(async () => {
    nested = await model.refreshSession()
  })
  await model.notify(session)
  return {
    nestedToken: nested.data.refresh_token,
    storedToken: model.storage.refresh_token,
    serviceCalls: model.serviceCalls,
  }
}

async function explicitOldNested(variant) {
  const model = new RefreshModel(variant)
  let outcome = null
  model.subscribe(async () => {
    outcome = await Promise.race([
      model.refreshSession({ refresh_token: 'R1' }).then(() => 'success'),
      delay(30).then(() => 'timeout'),
    ])
  })
  const outer = await within(model.callRefreshToken('R1'))
  await nextTurn()
  return {
    outcome,
    outerToken: outer.data.refresh_token,
    storedToken: model.storage.refresh_token,
    serviceCalls: model.serviceCalls,
  }
}

async function throwingSubscriber(variant) {
  const model = new RefreshModel(variant)
  const visited = []
  model.subscribe(async () => {
    visited.push('throwing')
    throw new Error('application subscriber failed')
  })
  model.subscribe(async () => {
    visited.push('healthy')
  })
  const outer = await within(model.callRefreshToken('R1'))
  return {
    outerToken: outer.data.refresh_token,
    storedToken: model.storage.refresh_token,
    serviceCalls: model.serviceCalls,
    visited,
    subscriberErrors: model.subscriberErrors,
  }
}

async function ssrWait(variant) {
  const model = new RefreshModel(variant)
  const started = new Deferred()
  const release = new Deferred()
  let callbackFinished = false
  model.subscribe(async () => {
    started.resolve()
    await release.promise
    callbackFinished = true
  })
  let outerSettled = false
  const outer = model.callRefreshToken('R1').then((result) => {
    outerSettled = true
    return result
  })
  await started.promise
  await nextTurn()
  const beforeRelease = { outerSettled, callbackFinished }
  release.resolve()
  await within(outer)
  return {
    beforeRelease,
    afterRelease: { outerSettled, callbackFinished },
  }
}

async function oldTokenJoiner(variant) {
  const model = new RefreshModel(variant)
  const started = new Deferred()
  const release = new Deferred()
  model.subscribe(async () => {
    started.resolve()
    await release.promise
  })
  const outer = model.callRefreshToken('R1')
  await started.promise
  let joinerSettled = false
  const joiner = model.callRefreshToken('R1').then((result) => {
    joinerSettled = true
    return result
  })
  await nextTurn()
  const settledBeforeSubscriberCompletion = joinerSettled
  release.resolve()
  await Promise.all([within(outer), within(joiner)])
  return {
    settledBeforeSubscriberCompletion,
    serviceCalls: model.serviceCalls,
  }
}

const results = {}
for (const variant of ['early-shared-settlement', 'token-aware-committed-result']) {
  results[variant] = {
    defaultNested: await defaultNested(variant),
    queuedDefaultNested: await queuedDefaultNested(variant),
    explicitOldNested: await explicitOldNested(variant),
    throwingSubscriber: await throwingSubscriber(variant),
    ssrWait: await ssrWait(variant),
    oldTokenJoiner: await oldTokenJoiner(variant),
  }
}

console.log(JSON.stringify(results, null, 2))
