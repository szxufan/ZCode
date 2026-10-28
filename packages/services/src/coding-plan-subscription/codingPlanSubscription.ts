import type {
  RequestVerificationConfig,
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckRequest,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanBillingDiscountConfig,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  ForceUpdateConfig,
  ManualClaimPlanPreviewSnapshot,
  ManualClaimPlanClaimRequest,
  ManualClaimPlanClaimResult,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ICodingPlanSubscriptionService {
  batchPreview(request?: CodingPlanBatchPreviewRequest): Promise<CodingPlanBatchPreviewResponse>;
  getStaticProducts(): Promise<CodingPlanStaticProductsConfig>;
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  getManualClaimPlanPreviews(): Promise<ManualClaimPlanPreviewSnapshot>;
  claimManualPlan(request: ManualClaimPlanClaimRequest): Promise<ManualClaimPlanClaimResult>;
  /**
   * 动态工作流灰度快照：远端 `configs.dynamicWorkflow.mode`
   * 与本地覆盖折叠后的结果；forceRefresh 绕过 1h 快照缓存。请求失败 fail-closed（disabled/default）。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  getBillingDiscount(): Promise<CodingPlanBillingDiscountConfig | undefined>;
  getRequestVerificationConfig(): Promise<RequestVerificationConfig | null>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo>;
  preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse>;
  createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse>;
  updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse>;
  checkPayment(request: CodingPlanPaymentCheckRequest): Promise<CodingPlanPaymentCheckResponse>;
  checkPendingOrders(
    request?: CodingPlanPendingOrderCheckRequest,
  ): Promise<CodingPlanPendingOrderCheckResponse>;
  queryStripeCards(request?: {
    providerId?: CodingPlanPreviewRequest["providerId"];
  }): Promise<CodingPlanStripeCard[]>;
  bindStripeCard(request: CodingPlanStripeBindRequest): Promise<CodingPlanStripeBindResponse>;
  unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string>;
  payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse>;
  checkPaypalSupport(
    request?: CodingPlanPaypalSupportRequest,
  ): Promise<CodingPlanPaypalSupportResponse>;
  createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse>;
  subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse>;
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
  getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse>;
  calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse>;
  createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]>;
  cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse>;
  continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);
