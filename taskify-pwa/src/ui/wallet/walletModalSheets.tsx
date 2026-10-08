import { lazy } from "react";

export const EcashReceiveSheet = lazy(() =>
  import("./EcashReceiveSheet").then((module) => ({ default: module.EcashReceiveSheet })),
);

export const LightningReceiveSheet = lazy(() =>
  import("./LightningReceiveSheet").then((module) => ({ default: module.LightningReceiveSheet })),
);

export const EcashSendSheet = lazy(() =>
  import("./EcashSendSheet").then((module) => ({ default: module.EcashSendSheet })),
);

export const WalletContactsSheet = lazy(() =>
  import("./WalletContactsSheet").then((module) => ({ default: module.WalletContactsSheet })),
);

export const LightningSendSheet = lazy(() =>
  import("./LightningSendSheet").then((module) => ({ default: module.LightningSendSheet })),
);

export const WalletHistorySheet = lazy(() =>
  import("./WalletHistorySheet").then((module) => ({ default: module.WalletHistorySheet })),
);

export const WalletSwapSheet = lazy(() =>
  import("./WalletSwapSheet").then((module) => ({ default: module.WalletSwapSheet })),
);

export const WalletNwcManagerSheet = lazy(() =>
  import("./WalletNwcManagerSheet").then((module) => ({ default: module.WalletNwcManagerSheet })),
);

export const WalletSettingsSheet = lazy(() =>
  import("./WalletSettingsSheet").then((module) => ({ default: module.WalletSettingsSheet })),
);

export const PaymentRequestFulfillSheet = lazy(() =>
  import("./PaymentRequestFulfillSheet").then((module) => ({ default: module.PaymentRequestFulfillSheet })),
);
