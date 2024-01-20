import base64
from algosdk import logic

# YOU ARE TO CHANGE THIS TO THE GORA TOKEN/APP ID YOU ARE WORKING WITH
GORA_TOKEN_ID = 1001
GORA_CONTRACT_ID = 1002



# DO NOT TOUCH THIS PART
GORA_CONTRACT_ADDRESS = logic.get_application_address(GORA_CONTRACT_ID)
addr_decoded = base64.b32decode(GORA_CONTRACT_ADDRESS + "======")
GORA_CONTRACT_ADDRESS_BIN = addr_decoded[:-4] # remove CRC