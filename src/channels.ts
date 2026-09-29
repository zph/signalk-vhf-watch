export type ChannelRegion = 'US' | 'CA' | 'US_CA'
export type ChannelCountry = 'US' | 'CA'

export interface VhfChannel {
  id: string
  label: string
  frequencyHz: number
  purpose: string
  countries: ChannelCountry[]
  weather?: boolean
}

type RegionalChannel = Omit<VhfChannel, 'countries'> & { country: ChannelCountry }

function channel(
  country: ChannelCountry,
  id: string,
  receiveMHz: number,
  purpose: string,
  weather = false
): RegionalChannel {
  return { country, id, label: id, frequencyHz: Math.round(receiveMHz * 1_000_000), purpose, ...(weather ? { weather: true } : {}) }
}

// USCG U.S. VHF Channel Information, using ship receive frequency for duplex channels.
const US_CHANNELS: readonly RegionalChannel[] = [
  channel('US', '01A', 156.050, 'Port operations and commercial; regional VTS'),
  channel('US', '05A', 156.250, 'Port operations or regional VTS'),
  channel('US', '06', 156.300, 'Intership safety'),
  channel('US', '07A', 156.350, 'Commercial'),
  channel('US', '08', 156.400, 'Commercial intership'),
  channel('US', '09', 156.450, 'Boater calling; commercial and non-commercial'),
  channel('US', '10', 156.500, 'Commercial'),
  channel('US', '11', 156.550, 'Commercial and regional VTS'),
  channel('US', '12', 156.600, 'Port operations and regional VTS'),
  channel('US', '13', 156.650, 'Bridge-to-bridge navigation safety'),
  channel('US', '14', 156.700, 'Port operations and regional VTS'),
  channel('US', '15', 156.750, 'Environmental; receive only'),
  channel('US', '16', 156.800, 'International distress, safety, and calling'),
  channel('US', '17', 156.850, 'State and local government maritime control'),
  channel('US', '18A', 156.900, 'Commercial'),
  channel('US', '19A', 156.950, 'Commercial'),
  channel('US', '20', 161.600, 'Port operations; duplex coast side'),
  channel('US', '20A', 157.000, 'Port operations'),
  channel('US', '21A', 157.050, 'US Coast Guard only'),
  channel('US', '22A', 157.100, 'Coast Guard liaison and marine safety broadcasts'),
  channel('US', '23A', 157.150, 'US Coast Guard only'),
  channel('US', '24', 161.800, 'Public correspondence; duplex coast side'),
  channel('US', '25', 161.850, 'Public correspondence; duplex coast side'),
  channel('US', '26', 161.900, 'Public correspondence; duplex coast side'),
  channel('US', '27', 161.950, 'Public correspondence; duplex coast side'),
  channel('US', '28', 162.000, 'Public correspondence; duplex coast side'),
  channel('US', '63A', 156.175, 'Regional port operations and commercial'),
  channel('US', '65A', 156.275, 'Port operations'),
  channel('US', '66A', 156.325, 'Port operations'),
  channel('US', '67', 156.375, 'Commercial and regional bridge-to-bridge'),
  channel('US', '68', 156.425, 'Non-commercial'),
  channel('US', '69', 156.475, 'Non-commercial'),
  channel('US', '71', 156.575, 'Non-commercial'),
  channel('US', '72', 156.625, 'Non-commercial intership'),
  channel('US', '73', 156.675, 'Port operations'),
  channel('US', '74', 156.725, 'Port operations'),
  channel('US', '77', 156.875, 'Port operations intership'),
  channel('US', '78A', 156.925, 'Non-commercial'),
  channel('US', '79A', 156.975, 'Commercial; Great Lakes non-commercial'),
  channel('US', '80A', 157.025, 'Commercial; Great Lakes non-commercial'),
  channel('US', '81A', 157.075, 'US government environmental operations'),
  channel('US', '82A', 157.125, 'US government only'),
  channel('US', '83A', 157.175, 'US Coast Guard only'),
  channel('US', '84', 161.825, 'Public correspondence; duplex coast side'),
  channel('US', '85', 161.875, 'Public correspondence; duplex coast side'),
  channel('US', '86', 161.925, 'Public correspondence; duplex coast side'),
  channel('US', '87', 157.375, 'Public correspondence'),
  channel('US', '88', 157.425, 'Commercial intership'),
  channel('US', 'WX1', 162.550, 'NOAA weather', true),
  channel('US', 'WX2', 162.400, 'NOAA weather', true),
  channel('US', 'WX3', 162.475, 'NOAA weather', true),
  channel('US', 'WX4', 162.425, 'NOAA weather', true),
  channel('US', 'WX5', 162.450, 'NOAA weather', true),
  channel('US', 'WX6', 162.500, 'NOAA weather', true),
  channel('US', 'WX7', 162.525, 'NOAA weather', true)
]

// Canadian Coast Guard Radio Aids to Marine Navigation 2026, Table 1-2. Entries without a ship
// receive frequency and digital-only/AIS channels are omitted from this analog voice receiver.
const CA_CHANNELS: readonly RegionalChannel[] = [
  channel('CA', '01', 160.650, 'Public correspondence; duplex coast side'),
  channel('CA', '02', 160.700, 'Public correspondence; duplex coast side'),
  channel('CA', '03', 160.750, 'Public correspondence; duplex coast side'),
  channel('CA', '04A', 156.200, 'DFO/CCG liaison and commercial fishing'),
  channel('CA', '05A', 156.250, 'Vessel Traffic Services'),
  channel('CA', '06', 156.300, 'SAR safety and intership'),
  channel('CA', '07A', 156.350, 'Commercial intership and ship/shore'),
  channel('CA', '08', 156.400, 'Commercial and safety intership'),
  channel('CA', '09', 156.450, 'VTS, intership, and non-commercial'),
  channel('CA', '10', 156.500, 'VTS and intership'),
  channel('CA', '11', 156.550, 'VTS and pilotage'),
  channel('CA', '12', 156.600, 'VTS, port operations, and pilotage'),
  channel('CA', '13', 156.650, 'VTS and bridge-to-bridge navigation'),
  channel('CA', '14', 156.700, 'VTS, port operations, and pilotage'),
  channel('CA', '15', 156.750, 'VTS and intership; low power'),
  channel('CA', '16', 156.800, 'International distress and safety'),
  channel('CA', '17', 156.850, 'Maritime control; low power'),
  channel('CA', '18A', 156.900, 'Commercial; towing on the BC coast'),
  channel('CA', '20', 161.600, 'Port operations; duplex coast side'),
  channel('CA', '21B', 161.650, 'CCG continuous marine and safety broadcasts'),
  channel('CA', '22A', 157.100, 'DFO/CCG liaison'),
  channel('CA', '23', 161.750, 'Public correspondence; duplex coast side'),
  channel('CA', '23B', 161.750, 'CCG continuous marine and safety broadcasts'),
  channel('CA', '24', 161.800, 'Public correspondence; duplex coast side'),
  channel('CA', '25', 161.850, 'Public correspondence; duplex coast side'),
  channel('CA', '25B', 161.850, 'Public correspondence; coast receive'),
  channel('CA', '26', 161.900, 'Public correspondence; duplex coast side'),
  channel('CA', '27', 161.950, 'Public correspondence; duplex coast side'),
  channel('CA', '28', 162.000, 'Public correspondence; duplex coast side'),
  channel('CA', '60', 160.625, 'Public correspondence; duplex coast side'),
  channel('CA', '61A', 156.075, 'DFO/CCG liaison and commercial fishing'),
  channel('CA', '62A', 156.125, 'DFO/CCG liaison and commercial fishing'),
  channel('CA', '63A', 156.175, 'Tow boats on the BC coast'),
  channel('CA', '64', 160.825, 'Public correspondence; duplex coast side'),
  channel('CA', '64A', 156.225, 'Commercial fishing'),
  channel('CA', '65A', 156.275, 'SAR and safety'),
  channel('CA', '66A', 156.325, 'Safety and ship/shore'),
  channel('CA', '67', 156.375, 'SAR safety and intership'),
  channel('CA', '68', 156.425, 'Marinas, yacht clubs, and pleasure craft'),
  channel('CA', '69', 156.475, 'Commercial fishing and non-commercial'),
  channel('CA', '71', 156.575, 'VTS, safety, and ship movement'),
  channel('CA', '72', 156.625, 'Commercial and non-commercial intership'),
  channel('CA', '73', 156.675, 'SAR safety and commercial fishing'),
  channel('CA', '74', 156.725, 'VTS and ship movement'),
  channel('CA', '75', 156.775, 'Ship movement; low power'),
  channel('CA', '76', 156.825, 'Ship movement; low power'),
  channel('CA', '77', 156.875, 'Safety and ship movement'),
  channel('CA', '78A', 156.925, 'Fishing-vessel intership'),
  channel('CA', '79A', 156.975, 'Fishing-vessel intership'),
  channel('CA', '80A', 157.025, 'Whale-watching intership'),
  channel('CA', '81A', 157.075, 'DFO/CCG liaison'),
  channel('CA', '82A', 157.125, 'DFO/CCG liaison'),
  channel('CA', '83A', 157.175, 'DFO, CCG, and government agencies'),
  channel('CA', '83B', 161.775, 'CCG continuous marine and safety broadcasts'),
  channel('CA', '84', 161.825, 'Public correspondence; duplex coast side'),
  channel('CA', '85', 161.875, 'Public correspondence; duplex coast side'),
  channel('CA', '86', 161.925, 'Public correspondence; duplex coast side'),
  channel('CA', '87', 157.375, 'Port operations and ship movement'),
  channel('CA', '88', 157.425, 'Port operations and ship movement'),
  channel('CA', 'WX1', 162.550, 'CCG continuous marine broadcast', true),
  channel('CA', 'WX2', 162.400, 'CCG continuous marine broadcast', true),
  channel('CA', 'WX3', 162.475, 'CCG continuous marine broadcast', true)
]

export function channelPlan(region: ChannelRegion): VhfChannel[] {
  const source = region === 'US' ? US_CHANNELS : region === 'CA' ? CA_CHANNELS : [...US_CHANNELS, ...CA_CHANNELS]
  const merged = new Map<string, VhfChannel>()
  for (const entry of source) {
    const key = `${entry.id}:${entry.frequencyHz}`
    const existing = merged.get(key)
    if (!existing) {
      const { country, ...rest } = entry
      merged.set(key, { ...rest, countries: [country] })
      continue
    }
    existing.countries.push(entry.country)
    if (existing.purpose !== entry.purpose) existing.purpose = `US: ${existing.purpose} · Canada: ${entry.purpose}`
  }
  return [...merged.values()].sort((left, right) => {
    if (Boolean(left.weather) !== Boolean(right.weather)) return left.weather ? 1 : -1
    const leftNumber = /^(\d+)([A-Z]*)$/.exec(left.id)
    const rightNumber = /^(\d+)([A-Z]*)$/.exec(right.id)
    if (leftNumber && rightNumber) {
      const numberDifference = Number(leftNumber[1]) - Number(rightNumber[1])
      if (numberDifference !== 0) return numberDifference
      return leftNumber[2]!.localeCompare(rightNumber[2]!)
    }
    return left.id.localeCompare(right.id, undefined, { numeric: true })
  })
}

export function channelById(id: string, region: ChannelRegion = 'US_CA'): VhfChannel | undefined {
  return channelPlan(region).find((entry) => entry.id === id.toUpperCase())
}

export const VHF_CHANNELS = channelPlan('US_CA')
