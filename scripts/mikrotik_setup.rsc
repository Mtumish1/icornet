# ==============================================================================
# iCornet - Mikrotik Hotspot Configuration Script
# ==============================================================================
# IMPORTANT: Adjust the variables below before running this script
# Run via WinBox terminal or SSH: /import mikrotik_setup.rsc
# ==============================================================================

:local bridgeName "br-hotspot"
:local hotspotAddress "192.168.100.1"
:local hotspotNetwork "192.168.100.0/24"
:local hotspotPoolRange "192.168.100.10-192.168.100.250"
:local dnsServers "8.8.8.8,8.8.4.4"
:local wanInterface "ether1"
# Which interfaces will serve the hotspot? (adjust as needed)
:local hotspotInterfaces "ether2,wlan1"
:local ssidName "FastWiFi_Premium"

# DNS Name for the Hotspot Login (will redirect to Node.js portal)
# NOTE: Set this to match the domain where your Node.js portal is hosted.
# Or leave it as a local DNS name and configure the walled garden.
:local hotspotDnsName "login.fastwifi.local"

/log info "Starting iCornet Hotspot Setup..."

# 1. Create Bridge
/interface bridge
add name=$bridgeName
/log info "Created bridge: $bridgeName"

# 2. Add Ports to Bridge
:foreach iface in=[:toarray $hotspotInterfaces] do={
    :do {
        /interface bridge port add bridge=$bridgeName interface=$iface
        /log info "Added $iface to bridge"
    } on-error={ /log warning "Could not add $iface to bridge (maybe it doesn't exist?)" }
}

# 3. Configure Wireless (if wlan1 is used)
:do {
    /interface wireless
    set [ find default-name=wlan1 ] ssid=$ssidName mode=ap-bridge disabled=no band=2ghz-b/g/n
    /log info "Configured WiFi SSID: $ssidName"
} on-error={ /log warning "Skipped WiFi configuration (no wlan1 found)" }

# 4. Assign IP Address to Bridge
/ip address
add address=($hotspotAddress . "/24") interface=$bridgeName network=[:pick $hotspotNetwork 0 [:find $hotspotNetwork "/"]]

# 5. Set Up DHCP Server
/ip pool
add name=hotspot-pool ranges=$hotspotPoolRange

/ip dhcp-server
add address-pool=hotspot-pool interface=$bridgeName name=hotspot-dhcp disabled=no

/ip dhcp-server network
add address=$hotspotNetwork gateway=$hotspotAddress dns-server=$dnsServers

# 6. Configure NAT (Internet Access)
/ip firewall nat
add action=masquerade chain=srcnat out-interface=$wanInterface comment="NAT for Hotspot"

# 7. Hotspot Configuration
/ip hotspot profile
add name=hsprof-icornet hotspot-address=$hotspotAddress dns-name=$hotspotDnsName login-by=mac,cookie,http-chap,http-pap

/ip hotspot
add address-pool=hotspot-pool interface=$bridgeName name=hotspot-icornet profile=hsprof-icornet disabled=no

# 8. User Profiles & Rate Limiting
# You can map these to the packages in your database
/ip hotspot user profile
set [ find default=yes ] shared-users=1 rate-limit="5M/5M" transparent-proxy=no

# 9. Walled Garden (Bypass logic for M-Pesa and Portal)
# Replace yourdomain.com with the domain hosting your Node.js portal!
/ip hotspot walled-garden
add dst-host="*safaricom.co.ke" action=allow comment="M-Pesa API"
add dst-host="*safaricom.com" action=allow comment="Safaricom Auth"
add dst-host="*yourdomain.com" action=allow comment="iCornet Node.js Portal"

# Allow API ports if needed
/ip hotspot walled-garden ip
add dst-port=443 action=allow protocol=tcp comment="HTTPS bypass"

/log info "iCornet Hotspot Setup Completed!"
