/**
 * Test fixtures: real response *shapes* captured from the live unit, with every
 * sensitive value replaced by an obvious placeholder.
 *
 * These are the raw rows as the router returns them — the tests push them
 * through `redactRow` and then the parsers, so the redaction is exercised on the
 * same path production uses rather than assumed.
 *
 * Nothing real survives here. The credentials, serial, MAC, public addresses,
 * ISP product name and host names are all invented; RFC 5737/3849 documentation
 * addresses are used where an address has to look public. This file is committed
 * to a public repository and must stay boring.
 */

/** `DEV2_FAST_LINE` — the carrier-health OID, and the one `status` that is truthful. */
export const FAST_LINE_ROW: Record<string, string> = {
  enable: '1',
  status: 'Up',
  alias: 'cpe-fastline',
  name: 'BBA_FAST_LINE',
  linkStatus: 'Up',
  allowedProfiles: '106a;212a',
  lineNumber: '1',
  upstreamMaxBitRate: '225452',
  downstreamMaxBitRate: '803140',
  X_TP_UpstreamCurrRate: '226413',
  X_TP_DownstreamCurrRate: '804707',
  upstreamNoiseMargin: '56',
  downstreamNoiseMargin: '61',
  upstreamAttenuation: '0',
  downstreamAttenuation: '85',
  stack: '1,0,0,0,0,0',
}

/** `DEV2_DSL_LINE_STATS` — byte counters and `showtimeStart` for the active line. */
export const DSL_LINE_STATS_ROW: Record<string, string> = {
  bytesSent: '543673926',
  bytesReceived: '1055593351',
  packetsSent: '653884',
  packetsReceived: '993395',
  totalStart: '14529',
  showtimeStart: '3589',
  // Same field name as on DEV2_FAST_LINE, three orders of magnitude apart. Not read.
  X_TP_DownstreamCurrRate: '3641',
  X_TP_UpstreamCurrRate: '566',
  stack: '1,0,0,0,0,0',
}

/**
 * `DEV2_ADT_WAN` — six configured connections, one live. Carries the PPPoE
 * credentials in cleartext, which is why the redaction canary lives here.
 */
export const ADT_WAN_ROWS: Array<Record<string, string>> = [
  {
    name: 'usb_ppp3g',
    customConnName: 'usb_ppp3g',
    connType: 'PPP3G',
    connStatusV4: 'Disconnected',
    connStatusV6: 'Disconnected',
    stack: '1,0,0,0,0,0',
  },
  {
    name: 'ipoe_ptm_0_0_d',
    customConnName: 'Example ISP Product',
    ifName: 'ppp0',
    connType: 'PPPoE',
    accessMode: 'VDSL',
    connStatusV4: 'Connecting',
    connStatusV6: 'Connected',
    connIPv4Address: '0.0.0.0',
    connIPv6Address: '2001:db8:1234:5678::1',
    MACAddr: '00:11:22:33:44:55',
    PPPUserName: 'fixture-account@example.invalid',
    PPPPassword: 'FIXTURE-CANARY-NOT-A-REAL-PASSWORD',
    serialNumber: 'FIXTURE-SERIAL-0001',
    X_TP_DsliteAftrServer: 'aftr.example.invalid',
    X_TP_DsliteEnable: '1',
    stack: '3,0,0,0,0,0',
  },
  {
    name: 'pppoe_40_2',
    customConnName: 'Example ISP Fibre',
    ifName: 'ppp1',
    connType: 'PPPoE',
    connStatusV4: 'Disconnected',
    connStatusV6: 'Disconnected',
    PPPUserName: 'fixture-account@example.invalid',
    PPPPassword: 'FIXTURE-CANARY-NOT-A-REAL-PASSWORD',
    stack: '5,0,0,0,0,0',
  },
]

/** `DEV2_IP_INTF` — names and connection types. Instance 2 has no `name` at all. */
export const IP_INTF_ROWS: Array<Record<string, string>> = [
  {
    status: 'Up',
    alias: 'cpe-ipintf',
    name: 'br0',
    X_TP_ConnType: 'LAN',
    X_TP_ConnName: 'Default',
    stack: '1,0,0,0,0,0',
  },
  {
    status: 'Down',
    alias: 'cpe-ipintf',
    X_TP_ConnType: 'PPP3G',
    X_TP_ConnName: 'usb_ppp3g',
    stack: '2,0,0,0,0,0',
  },
  {
    // Reads `Down` while carrying hundreds of megabytes — this status lies.
    status: 'Down',
    alias: 'Example ISP Product',
    name: 'ppp0',
    X_TP_ConnType: 'PPPoE',
    X_TP_ConnName: 'ipoe_ptm_0_0_d',
    stack: '4,0,0,0,0,0',
  },
]

/** `DEV2_IP_INTF_STATS` — rates and byte counters, no name; pairs by `stack`. */
export const IP_INTF_STATS_ROWS: Array<Record<string, string>> = [
  {
    X_TP_LastPeriod: '33',
    X_TP_TxThroughput: '441',
    X_TP_RxThroughput: '1814',
    bytesSent: '7359870067',
    bytesReceived: '3214640826',
    stack: '1,0,0,0,0,0',
  },
  {
    X_TP_LastPeriod: '33',
    X_TP_TxThroughput: '0',
    X_TP_RxThroughput: '0',
    bytesSent: '0',
    bytesReceived: '0',
    stack: '2,0,0,0,0,0',
  },
  {
    X_TP_LastPeriod: '33',
    X_TP_TxThroughput: '1823',
    X_TP_RxThroughput: '436',
    bytesSent: '1073813360',
    bytesReceived: '1680923801',
    stack: '4,0,0,0,0,0',
  },
]

/**
 * `DEV2_ETH_INTF` — the router-side view of each port's negotiated link. LAN1
 * negotiated 1000 and LAN2 negotiated 100, both `Up`: the reason a host's port
 * must be resolved rather than guessed.
 */
export const ETH_INTF_ROWS: Array<Record<string, string>> = [
  {
    status: 'Up',
    name: 'eth0',
    X_TP_IfNameAlias: 'LAN1',
    MACAddress: '00:11:22:33:44:55',
    maxBitRate: '1000',
    duplexMode: 'Full',
    stack: '1,0,0,0,0,0',
  },
  {
    status: 'Up',
    name: 'eth1',
    X_TP_IfNameAlias: 'LAN2',
    MACAddress: '00:11:22:33:44:55',
    maxBitRate: '100',
    duplexMode: 'Full',
    stack: '2,0,0,0,0,0',
  },
  {
    status: 'Down',
    name: 'eth2',
    X_TP_IfNameAlias: 'EWAN',
    MACAddress: '00:11:22:33:44:55',
    maxBitRate: '0',
    duplexMode: 'Half',
    stack: '3,0,0,0,0,0',
  },
]

/** `DEV2_HOSTS` — the count that validates the host list. */
export const HOSTS_ROW: Record<string, string> = {
  hostNumberOfEntries: '3',
  stack: '0,0,0,0,0,0',
}

/** `DEV2_HOST_ENTRY` — must be read with `gl`; `go` returns only the first row. */
export const HOST_ENTRY_ROWS: Array<Record<string, string>> = [
  {
    physAddress: '00:11:22:33:44:55',
    IPAddress: '192.168.1.100',
    addressSource: 'DHCP',
    layer1Interface: 'Device.Ethernet.Interface.1.',
    hostName: 'fixture-host',
    interfaceType: 'Ethernet',
    X_TP_LanConnDev: 'br0',
    active: '1',
    X_TP_ClientType: 'Other',
    stack: '0,0,0,0,0,0',
  },
  {
    physAddress: '00:11:22:33:44:66',
    IPAddress: '192.168.1.104',
    layer1Interface: 'Device.WiFi.Radio.1.',
    hostName: 'fixture-phone',
    interfaceType: 'Wi-Fi',
    active: '1',
    X_TP_ClientType: 'Phone',
    stack: '0,0,0,0,0,0',
  },
  {
    physAddress: '00:11:22:33:44:77',
    IPAddress: '192.168.1.105',
    layer1Interface: 'Device.Ethernet.Interface.2.',
    hostName: 'fixture-stale-lease',
    interfaceType: 'Ethernet',
    // Inactive: a stale DHCP lease, not a connection.
    active: '0',
    X_TP_ClientType: 'Other',
    stack: '0,0,0,0,0,0',
  },
]
