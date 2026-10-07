# QA report · Acme Shop checkout regression v2.3.0

Run `acme-shop-checkout-regre-20261007-28nj` · environment **mock** · generated 2026-10-07T13:44:30.302Z
Build under test https://staging.acme-shop.example

## Release gate ❌ FAIL, release blocked

- TC-02 [high] fails on Android phone (Chrome) (2 fail / 0 pass)

Testers submitted **24** results, 12 valid, 6 incomplete, 6 invalid. 12 approved, 12 rejected, **24.00 USDC** paid out.

## Results matrix

| Case | Priority | Android phone (Chrome) | iPhone (Safari) | Desktop browser |
| --- | --- | --- | --- | --- |
| TC-01 Guest checkout with card | high | ✅ pass (2) | ✅ pass (2) | ✅ pass (2) |
| TC-02 Apply a coupon at checkout | high | ❌ fail (2) | ✅ pass (2) | ✅ pass (2) |
| TC-03 Order confirmation email | medium | ✅ pass (2) | ⚠️ disputed (2) | ✅ pass (2) |
| TC-04 Delivery address validation | medium | ✅ pass (2) | ✅ pass (2) | ✅ pass (2) |
| TC-05 Cart survives a page refresh | low | ✅ pass (2) | ✅ pass (2) | ✅ pass (2) |
| TC-06 Pay with bank transfer | high | ✅ pass (2) | ✅ pass (2) | ✅ pass (2) |
| TC-07 Checkout on a slow 3G connection | medium | ✅ pass (2) | ✅ pass (2) | n/a |
| TC-08 Keyboard-only checkout | low | n/a | n/a | ✅ pass (2) |

## Failures and blockers

### TC-02 Apply a coupon at checkout on Android phone (Chrome) (fail)

Expected Total drops by 10 percent, the Pay button stays enabled and the order is placed

- **FAIL** by @ada_qa (Samsung Galaxy A14, Android 14, Chrome 129). Pay button stays disabled after applying coupon SAVE10, order cannot be placed · evidence https://drive.example.com/bugbash/ada_qa/tc-02.mp4
- **FAIL** by @tunde.tests (Tecno Spark 20, Android 13, Chrome 128). Pay button stays disabled after applying coupon SAVE10, order cannot be placed · evidence https://drive.example.com/bugbash/tunde.tests/tc-02.mp4

### TC-03 Order confirmation email on iPhone (Safari) (disputed)

Expected Confirmation email with the same order number arrives within 2 minutes

- **FAIL** by @ada_qa (iPhone 12, iOS 17.6, Safari). Confirmation email arrived after 9 minutes, expected under 2 · evidence https://drive.example.com/bugbash/ada_qa/tc-03.mp4
- **PASS** by @tunde.tests (iPhone SE (2nd gen), iOS 16.7, Safari). email arrived in about 40 seconds

## Tester ledger

| Tester | Bounty | Device | Parse verdict | Review | Payout | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| @quickcash99 | android-chrome-1 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | android-chrome-1 | Samsung Galaxy A14, Android 14, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | android-chrome-1 | Tecno Spark 20, Android 13, Chrome 128 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | android-chrome-1 | Infinix Hot 40i, Android 13, Chrome 129 | incomplete | rejected |  | Missing results for TC-05; TC-02 is FAIL without an evidence link |
| @quickcash99 | android-chrome-2 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | android-chrome-2 | Samsung Galaxy A14, Android 14, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | android-chrome-2 | Tecno Spark 20, Android 13, Chrome 128 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | android-chrome-2 | Infinix Hot 40i, Android 13, Chrome 129 | incomplete | rejected |  | Missing results for TC-07 |
| @quickcash99 | desktop-1 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | desktop-1 | ThinkPad T480, Windows 11, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | desktop-1 | MacBook Air M1, macOS 14, Firefox 131 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | desktop-1 | Dell Latitude, Ubuntu 24.04, Chrome 129 | incomplete | rejected |  | Missing results for TC-05 |
| @quickcash99 | desktop-2 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | desktop-2 | ThinkPad T480, Windows 11, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | desktop-2 | MacBook Air M1, macOS 14, Firefox 131 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | desktop-2 | Dell Latitude, Ubuntu 24.04, Chrome 129 | incomplete | rejected |  | Missing results for TC-08 |
| @quickcash99 | ios-safari-1 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | ios-safari-1 | iPhone 12, iOS 17.6, Safari | valid | approved | 2.00 USDC |  |
| @tunde.tests | ios-safari-1 | iPhone SE (2nd gen), iOS 16.7, Safari | valid | approved | 2.00 USDC |  |
| @kemi_bugs | ios-safari-1 | iPhone 14, iOS 18.0, Safari | incomplete | rejected |  | Missing results for TC-05 |
| @quickcash99 | ios-safari-2 |  | invalid | rejected |  | No result block found. Use the BUGBASH RESULT template from the bounty. |
| @ada_qa | ios-safari-2 | iPhone 12, iOS 17.6, Safari | valid | approved | 2.00 USDC |  |
| @tunde.tests | ios-safari-2 | iPhone SE (2nd gen), iOS 16.7, Safari | valid | approved | 2.00 USDC |  |
| @kemi_bugs | ios-safari-2 | iPhone 14, iOS 18.0, Safari | incomplete | rejected |  | Missing results for TC-07 |

## Bounties

- `android-chrome-1` [QA] Acme Shop checkout regression v2.3.0 on Android phone (Chrome) (part 1/2) · 5 cases · task fe44aade-7646-48f6-8d1e-18f6c6152ce5 · tx 11d877b6b8e7eb42263e8893054c44ef8bff9fbbf9a3
- `android-chrome-2` [QA] Acme Shop checkout regression v2.3.0 on Android phone (Chrome) (part 2/2) · 2 cases · task 0171b43a-3fae-49a6-9d32-f32f4152d3be · tx 7c2147745e6a62999534ceeb6745395329d7bc2e18fe
- `ios-safari-1` [QA] Acme Shop checkout regression v2.3.0 on iPhone (Safari) (part 1/2) · 5 cases · task 3c815d42-a4eb-490a-9bf0-1ca46c24f284 · tx 54aa50290a836bd58f5d53d8ebec733620fdbf28f429
- `ios-safari-2` [QA] Acme Shop checkout regression v2.3.0 on iPhone (Safari) (part 2/2) · 2 cases · task e278d53d-6208-474a-a708-49d391b64014 · tx 4a06ca36a8163c05dd756097de8f194181a39f6e2ae6
- `desktop-1` [QA] Acme Shop checkout regression v2.3.0 on Desktop browser (part 1/2) · 5 cases · task 53572156-360f-4472-9388-fbc7614b573f · tx 2d4fd226160f41633e8fe897a8c46c7b95299ede236d
- `desktop-2` [QA] Acme Shop checkout regression v2.3.0 on Desktop browser (part 2/2) · 2 cases · task 7e23cba0-81d8-438b-9cee-afc9c8830583 · tx 5302426b6499bc190b1bee001cf52762a6b7514f05b4

Generated by gibwork-bugbash using the Gibwork SDK.