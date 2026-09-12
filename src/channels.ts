export interface VhfChannel {
  id: string
  label: string
  frequencyHz: number
  purpose: string
  weather?: boolean
}

// Receive frequencies for common US recreational, safety, port, and NOAA weather channels.
// The plugin is receive-only and deliberately omits DSC channel 70 from the voice tuner.
export const VHF_CHANNELS: readonly VhfChannel[] = [
  { id: '09', label: '09', frequencyHz: 156_450_000, purpose: 'Boater calling' },
  { id: '13', label: '13', frequencyHz: 156_650_000, purpose: 'Bridge-to-bridge safety' },
  { id: '14', label: '14', frequencyHz: 156_700_000, purpose: 'Port operations' },
  { id: '16', label: '16', frequencyHz: 156_800_000, purpose: 'Distress, safety, and calling' },
  { id: '22A', label: '22A', frequencyHz: 157_100_000, purpose: 'Coast Guard liaison' },
  { id: '68', label: '68', frequencyHz: 156_425_000, purpose: 'Non-commercial working' },
  { id: '69', label: '69', frequencyHz: 156_475_000, purpose: 'Non-commercial working' },
  { id: '71', label: '71', frequencyHz: 156_575_000, purpose: 'Non-commercial working' },
  { id: '72', label: '72', frequencyHz: 156_625_000, purpose: 'Non-commercial ship-to-ship' },
  { id: 'WX1', label: 'WX1', frequencyHz: 162_550_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX2', label: 'WX2', frequencyHz: 162_400_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX3', label: 'WX3', frequencyHz: 162_475_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX4', label: 'WX4', frequencyHz: 162_425_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX5', label: 'WX5', frequencyHz: 162_450_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX6', label: 'WX6', frequencyHz: 162_500_000, purpose: 'NOAA weather', weather: true },
  { id: 'WX7', label: 'WX7', frequencyHz: 162_525_000, purpose: 'NOAA weather', weather: true }
]

export function channelById(id: string): VhfChannel | undefined {
  return VHF_CHANNELS.find((channel) => channel.id === id.toUpperCase())
}
