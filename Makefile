# Pricing automation via Makefile
# Usage examples:
#   make update_pricing AGENCY_PRICE=100 AGENCY_PERIOD=month AGENCY_CREDITS=unlimited BEGINNER_CREDITS=20 PRO_CREDITS=30 CREDIT_UNIT='1 video credit = 1 generated video'
#   make update_pricing AGENCY_PRICE_TEXT='\$100/month' AGENCY_CREDITS=unlimited BEGINNER_CREDITS=20 PRO_CREDITS=30 CREDIT_UNIT='1 video credit = 1 generated video'

# Defaults (can be overridden via CLI)
AGENCY_PRICE ?= 100
AGENCY_PERIOD ?= month
AGENCY_CREDITS ?= unlimited
BEGINNER_CREDITS ?= 20
PRO_CREDITS ?= 30
CREDIT_UNIT ?= 1 video credit = 1 generated video
BEGINNER_PRICE ?= 15/mo
PRO_PRICE ?= 49/mo

PRICING_JSON := config/pricing.json

.PHONY: update_pricing
update_pricing:
	@echo "Updating $@ -> $(PRICING_JSON)"
	@node scripts/update_pricing.mjs
	@echo "Done. Remember to rebuild your Next.js app if running in production."

