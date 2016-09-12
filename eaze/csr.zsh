eaze-csr () {
  local country='US'
  local state='CA'
  local city='San Francisco'
  local organization='Eaze Solutions, Inc.'
  local unit='Engineering'
  local fqdn=$1

  csr $fqdn -subj "/C=$country/ST=$state/L=$city/O=$organization/OU=$unit/CN=$fqdn"
}