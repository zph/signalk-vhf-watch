import type { DscMessage } from './dsc'

export interface DscCallerIdentity {
  name?: string
  callsign?: string
}

type SignalKNode = Record<string, unknown>

function record(value: unknown): SignalKNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as SignalKNode
    : undefined
}

function valueAt(node: unknown): unknown {
  const object = record(node)
  return object && Object.hasOwn(object, 'value') ? object.value : node
}

function nonEmptyText(value: unknown): string | undefined {
  const text = valueAt(value)
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

/** Resolve an MMSI against Signal K's live vessel tree. */
export function findDscCallerIdentity(vessels: unknown, mmsi: string | undefined): DscCallerIdentity | undefined {
  if (!mmsi) return undefined
  const vesselTree = record(vessels)
  const vessel = record(vesselTree?.[`urn:mrn:imo:mmsi:${mmsi}`]) ?? Object.values(vesselTree ?? {})
    .map(record)
    .find((candidate) => nonEmptyText(candidate?.mmsi) === mmsi)
  if (!vessel) return undefined

  const communication = record(vessel.communication)
  const identity: DscCallerIdentity = {
    name: nonEmptyText(vessel.name),
    callsign: nonEmptyText(communication?.callsignVhf)
  }
  return identity.name || identity.callsign ? identity : undefined
}

/** Add live identity fields to a copy so cached DSC decodes remain independent of AIS updates. */
export function enrichDscMessages(
  messages: DscMessage[],
  resolve: (mmsi: string | undefined) => DscCallerIdentity | undefined
): DscMessage[] {
  return messages.map((message) => {
    const { callerName: _oldName, callerCallsign: _oldCallsign, ...clean } = message
    let caller: DscCallerIdentity | undefined
    try {
      caller = resolve(message.selfMmsi)
    } catch {
      // An AIS lookup failure must not hide the DSC call itself.
    }
    return {
      ...clean,
      ...(caller?.name ? { callerName: caller.name } : {}),
      ...(caller?.callsign ? { callerCallsign: caller.callsign } : {})
    }
  })
}
