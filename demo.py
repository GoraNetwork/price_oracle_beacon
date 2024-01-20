from dotenv import load_dotenv
load_dotenv()
import time,base64
import beaker as BK
from build import build
from pathlib import Path
from typing import Union,List
from algosdk.transaction import PaymentTxn
from utils.consts import GORA_CONTRACT_ID,GORA_TOKEN_ID
from algosdk.atomic_transaction_composer import TransactionWithSigner
from algokit_utils import Account,ApplicationClient,OnCompleteCallParameters
from price_oracle_beacon.utils.algosdk_helpers import (ALGOD_CLIENT,describe_gora_num,
                                                       fund_account,get_gora_box_name,
                                                       stake_algo_for_requests,stake_gora_for_requests
                                                    )





class OraclePrice():
    """
    A simple class to instantialize oracle demo
    """

    def __init__(self) -> None:
        self.CONTRACT_ID = None
        self.PRICE_CLIENT = None
        self.CONTRACT_ADDRESS = None
        self.creator = BK.localnet.get_accounts()[0]
        self.suggested_params = ALGOD_CLIENT.suggested_params()
    

    def fund_accounts(self):
        """FUND THE CONTRACT CREATOR AND REQUESTER ACCOUNT"""
        fund_account(self.creator.address, 1_000_000_000_000)

    
    def deploy_contract(self,requester:Account):
        """ COMPILE THE ORACLE PRICE APP SPEC AND TEAL FILES 
        AND CREATE THE  ORACLE PRICE CONTRACT AND OPTIN THE CONTRACT 
        """

        app_spec_path = Path(build())
        self.PRICE_CLIENT = ApplicationClient(
            algod_client=ALGOD_CLIENT,
            app_spec=app_spec_path,
            signer=requester,
        )
        self.PRICE_CLIENT.create()
        self.CONTRACT_ID = self.PRICE_CLIENT.app_id
        self.CONTRACT_ADDRESS = self.PRICE_CLIENT.app_address
        fund_account(self.CONTRACT_ADDRESS, 1_000_000_000_000)

        self.PRICE_CLIENT.call(
            "opt_in_gora",
            asset_reference = GORA_TOKEN_ID,
            main_app_reference = GORA_CONTRACT_ID,
            transaction_parameters=OnCompleteCallParameters(
                signer=requester.signer,
                sender=requester.address,
                suggested_params=self.suggested_params,
                boxes=[(self.CONTRACT_ID, requester.address)],
            ),
        )        
        print(f"PRICE ORACLE APP ID : {self.CONTRACT_ID} \n APP ADDRESS : {self.CONTRACT_ADDRESS}")
    

    def __create_request_params_box(self,requester:Account,price_pair_name:bytes,user_data:bytes,token_asset_id:int,agg_method:int,source_arr:List[Union[int, List[bytes], int]]):
        """THIS METHOD IS USED TO SAVE THE CONTRACT'S REQUEST PARAMETER ON THE CONTRACT"""
        print("CREATING A BOX FOR THE REQUEST PARAMS")
        requestParamsBoxCost = 10_000_000

        self.PRICE_CLIENT.call(
            "create_request_params_box",
            price_pair_name = price_pair_name,
            token_asset_id = token_asset_id,
            source_arr = (source_arr,),
            agg_method = agg_method,
            user_data = user_data,
            algo_xfer = TransactionWithSigner(
                txn=PaymentTxn(
                    sp=self.suggested_params,
                    sender=requester.address,
                    amt=requestParamsBoxCost,
                    receiver=self.CONTRACT_ADDRESS,
                ),
                signer=requester.signer,
            ),

            transaction_parameters=OnCompleteCallParameters(
                signer=requester.signer,
                sender=requester.address,
                boxes=[ (self.CONTRACT_ID, b"req"+price_pair_name)],
            ),
        )

    
    def __create_price_box(self,requester:Account,price_pair_name:bytes):
        """ CALLS THE CONTRACT'S create_price_box METHOD """
        print("CREATING A BOX TO HOLD THE ORACLE PRICE RESULT")
        requestParamsBoxCost = (len(price_pair_name) + 17)*400 + 2500

        self.PRICE_CLIENT.call(
            "create_price_box",
            price_pair_name = price_pair_name,
            algo_xfer = TransactionWithSigner(
                txn=PaymentTxn(
                    sp=self.suggested_params,
                    sender=requester.address,
                    amt=requestParamsBoxCost,
                    receiver=self.CONTRACT_ADDRESS,
                ),
                signer=requester.signer,
            ),

            transaction_parameters=OnCompleteCallParameters(
                signer=requester.signer,
                sender=requester.address,
                boxes=[ (self.CONTRACT_ID,price_pair_name)],
            ),
        )
    

    def __stake_gora_and_algo(self,requester:Account):
        """
            THIS IS USED TO FUND THE GORA PROTOCOL ON BEHALF
            OF THE CONTRACT SO WE CAN MAKE SOME CALLS
        """

        print("STAKING SOME GORA AND ALGO TO THE GORA CONTRACT......")
        deposit_amount = 10_000_000_000
        stake_algo_for_requests(
            ALGOD_CLIENT,
            requester,
            deposit_amount,
            self.CONTRACT_ADDRESS,
            GORA_CONTRACT_ID
        )

        stake_gora_for_requests(
            ALGOD_CLIENT,
            requester,
            deposit_amount,
            self.CONTRACT_ADDRESS,
            GORA_CONTRACT_ID,
            GORA_TOKEN_ID
        )

        print("STAKED GORA AND ALGO TO THE GORA CONTRACT")

    def __fetch_token_price_request(self,requester:Account,price_pair_name:bytes,request_key:bytes):
        """
            THIS METHOD IS USED TO SEND A REQUEST TO THE ORACLE,
            FECTHING THE ALREADY SET REQUEST PARAMETERS
        """

        print(f"FETCHING GORA PRICE DATA FOR {price_pair_name.upper()}")
        box_name = get_gora_box_name(request_key, self.CONTRACT_ADDRESS)

        self.PRICE_CLIENT.call(
            "send_request",
            price_pair_name = price_pair_name,
            key = request_key,
            transaction_parameters=OnCompleteCallParameters(
                signer=requester.signer,
                sender=requester.address,
                # suggested_params=self.suggested_params,
                foreign_apps=[ GORA_CONTRACT_ID ],
                boxes=[
                    (GORA_CONTRACT_ID, box_name),
                    (GORA_CONTRACT_ID, price_pair_name),
                    (self.CONTRACT_ID, b"req"+price_pair_name), ],
            ),
        )

        print("GORA PRICE DATA FETCHED")



    def run_demo(self):
        """
            RUN THE ORACLE PRICE DEMO
        """

        # DEPLOY THE CONTRACT TO LOCALNET AND STORE THE NECCESSARY CONSTANTS
        self.deploy_contract(self.creator)

        # THIS WILL SERVE AS OUR ORACLE RESULT KEY
        # IT IS RECCOMMENDED YOU USE THE PRICE PAIR AS THE RESPONSE KEY TO AVOID CONFUSING IN CASE OF MULTIPLE PRICE FEEDS
        price_pair = b"btc/usd"
        request_key = bytes(f"req{price_pair}".encode("utf-8"))

        # THE ARGUMENTS TO PARSE TO THE ORACLE, THIS IS STORED UNCHAIN BY THE CONTRACT'S 'create_request_params_box'
        sourceArg = [
                        7, # sourceID
                        [
                            b"##signKey",  # API key
                            b"btc", # Currency 1
                            b"usd" # Currency 2
                        ] ,
                        60
                    ]

        # CREATE AND STORE THE ORACLE REQUEST PARAMETERS ON THE BLOCK CHAIN FOR EASE OF ACCESS AND USE BY THE CONTRACT
        self.__create_request_params_box(
            requester=self.creator,
            price_pair_name=price_pair,
            user_data=price_pair,
            token_asset_id=GORA_TOKEN_ID,
            agg_method=0,
            source_arr=sourceArg
        )

        # CREATE THE BOX TO WHICH THE ORACLE RESPONSE WILL BE STORED IN
        self.__create_price_box(
            requester=self.creator,
            price_pair_name=price_pair
        )

        # THIS IS A MUST, YOU HAVE TO STAKE SOME ALGOS AND GORA UNBEHALF OF THE CALLING CONTRACT SO YOU CAN MAKE A CALL
        self.__stake_gora_and_algo(self.creator)


        # PLACE/MAKE A REQUEST FOR THE PRICE PAIR YOU ARE LOOKING FOR
        self.__fetch_token_price_request(
            requester=self.creator,
            price_pair_name=price_pair,
            request_key=request_key
        )
        # AFTER MAKING AN ORACLE REQUEST YOU HAVE TO WAIT FOR APPROXIMATELY 10secs 
        # FOR THE ORACLE TO WRITE THE RESPONSE TO THE BOX
        time.sleep(10)
        oracle_response = ALGOD_CLIENT.application_box_by_name(self.CONTRACT_ID,price_pair)
        response = base64.b64decode(oracle_response.get("value"))
        oracle_price_result = describe_gora_num(response)
        print(f"ORACLE PRICE DATA FOR {price_pair.upper()} :: {oracle_price_result}")




Oracle_Price = OraclePrice()

Oracle_Price.run_demo()