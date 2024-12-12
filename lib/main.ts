import { config } from 'dotenv';
import { ChainId, Token, CurrencyAmount, TradeType, Percent } from '@uniswap/sdk-core';
import { Pool, Route, SwapQuoter, SwapRouter, Trade } from '@uniswap/v3-sdk';
import { Contract, ethers } from 'ethers';
import JSBI from 'jsbi';

type RouteStep = [string, string, number]; // [token_in_address, token_out_address, fee]
config();
function getEnvVar(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Environment variable ${key} is not set`);
    }
    return value;
  }

async function doubleMultiHopSwap(
  token_in: Token,
  token_out: Token,
  amount_in: string | number,
  best_route: RouteStep[],
  best_route1: RouteStep[],
  provider_address: string
): Promise<[string | null, string | null]> {
  // Polygonプロバイダーの設定
  const provider = new ethers.JsonRpcProvider(provider_address);
  const signer = new ethers.Wallet(getEnvVar('PRIVATE_KEY'), provider);

  // SwapRouterのアドレス（Polygon用）
  const SWAP_ROUTER_ADDRESS = getEnvVar('SWAP_ROUTER_ADDRESS');

  // 最初のスワップ：token_in から token_out へ
  const poolsForward = await createPoolsFromRoute(best_route, provider);
  const routeForward = new Route(poolsForward, token_in, token_out);

  // token_inが18デシマル、token_outが6デシマルの場合の金額調整
  const adjustedAmountIn = CurrencyAmount.fromRawAmount(token_in, JSBI.BigInt(amount_in.toString()));
  
  const quoteForward = await SwapQuoter.quoteCallParameters(
    routeForward,
    adjustedAmountIn,
    TradeType.EXACT_INPUT
  ); 
  const outputAmount_forward = await routeForward.pools[0].getOutputAmount(adjustedAmountIn)[0];


  const uncheckedTradeForward = Trade.createUncheckedTrade({
    route: routeForward,
    inputAmount: adjustedAmountIn,
    outputAmount: outputAmount_forward,
    tradeType: TradeType.EXACT_INPUT,
  });

  const optionsForward = {
    slippageTolerance: new Percent(50, 10000), // スリッページ許容値
    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // トランザクションの有効期限
    recipient: await signer.getAddress(),
  };

  const methodParametersForward = SwapRouter.swapCallParameters(uncheckedTradeForward, optionsForward);

  const txForward = {
    data: methodParametersForward.calldata,
    to: SWAP_ROUTER_ADDRESS,
    value: methodParametersForward.value,
    from: await signer.getAddress(),
    gasPrice: (await provider.getFeeData()).gasPrice,
    gasLimit: BigInt(1000000),
  };

  const txResponseForward = await signer.sendTransaction(txForward);
  const receiptForward = await txResponseForward.wait();
  if (!receiptForward || !receiptForward.hash) {
    throw new Error("Forward transaction failed");
  }

  // 2番目のスワップ：token_outからtoken_inへ
  const poolsBackward = await createPoolsFromRoute(best_route1, provider);
  const routeBackward = new Route(poolsBackward, token_out, token_in);

  // token_outが6デシマルなので、出力金額を調整して使用
  const amountInBackward = CurrencyAmount.fromRawAmount(token_out, JSBI.BigInt(outputAmount_forward.toString()));

  const quoteBackward = await SwapQuoter.quoteCallParameters(
    routeBackward,
    amountInBackward,
    TradeType.EXACT_INPUT
  );
  const outputAmount_backward = await routeForward.pools[0].getOutputAmount(adjustedAmountIn)[0];

  const uncheckedTradeBackward = Trade.createUncheckedTrade({
    route: routeBackward,
    inputAmount: amountInBackward,
    outputAmount: outputAmount_backward,
    tradeType: TradeType.EXACT_INPUT,
  });

  const optionsBackward = {
    slippageTolerance: new Percent(50, 10000), // スリッページ許容値
    deadline: Math.floor(Date.now() / 1000) + 60 * 20, // トランザクションの有効期限
    recipient: await signer.getAddress(),
  };

  const methodParametersBackward = SwapRouter.swapCallParameters(uncheckedTradeBackward, optionsBackward);

  const txBackward = {
    data: methodParametersBackward.calldata,
    to: SWAP_ROUTER_ADDRESS,
    value: methodParametersBackward.value,
    from: await signer.getAddress(),
    gasPrice: (await provider.getFeeData()).gasPrice,
    gasLimit: BigInt(1000000),
  };

  const txResponseBackward = await signer.sendTransaction(txBackward);
  const receiptBackward = await txResponseBackward.wait();
  // レシートのnullチェックと型の安全な取り扱い
  if (!receiptBackward || !receiptBackward.hash) {
    throw new Error("Backward transaction failed");
  }

  // hashプロパティを使用して取引ハッシュを取得
  return [receiptForward.hash, receiptBackward.hash];
}

async function createPoolsFromRoute(route: RouteStep[], provider: ethers.Provider): Promise<Pool[]> {
  const pools: Pool[] = [];

  for (const [tokenInAddress, tokenOutAddress, fee] of route) {
    // ERC20トークンのデシマルを取得
    const tokenAContract = new Contract(
      tokenInAddress,
      ['function decimals() external view returns (uint8)'],
      provider
    );
    const tokenBContract = new Contract(
      tokenOutAddress,
      ['function decimals() external view returns (uint8)'],
      provider
    );

    const [tokenADecimals, tokenBDecimals] = await Promise.all([
      tokenAContract.decimals(),
      tokenBContract.decimals()
    ]);
    const tokenA = new Token(ChainId.POLYGON, tokenInAddress, tokenADecimals); // デシマルを適切に設定
    const tokenB = new Token(ChainId.POLYGON, tokenOutAddress, tokenBDecimals); // デシマルを適切に設定

    const poolAddress = Pool.getAddress(tokenA, tokenB, fee);
    
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick)'],
        provider
      );

      const [sqrtPriceX96, tick] = await poolContract.slot0();

      pools.push(
        new Pool(
          tokenA,
          tokenB,
          fee,
          sqrtPriceX96.toString(),
          '0', // liquidity (set to '0' as we don't need it for routing)
          tick
        )
      );
      
    } catch (error) {
      console.error(`Error fetching pool data for ${tokenInAddress} and ${tokenOutAddress}:`, error);
      throw error; // Handle error as needed
    }
    
  }

  return pools;
}
