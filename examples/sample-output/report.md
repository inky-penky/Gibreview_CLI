# QA report · Acme Shop checkout regression v2.3.0

Run `acme-shop-checkout-regre-20261027-z816` · environment **mock** · generated 2026-10-27T19:45:43.430Z
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

- **FAIL** by @ada_qa (Samsung Galaxy A14, Android 14, Chrome 129). Pay button stays disabled after applying coupon SAVE10, order cannot be placed · evidence https://drive.example.com/gibreview/ada_qa/tc-02.mp4
- **FAIL** by @tunde.tests (Tecno Spark 20, Android 13, Chrome 128). Pay button stays disabled after applying coupon SAVE10, order cannot be placed · evidence https://drive.example.com/gibreview/tunde.tests/tc-02.mp4

### TC-03 Order confirmation email on iPhone (Safari) (disputed)

Expected Confirmation email with the same order number arrives within 2 minutes

- **FAIL** by @ada_qa (iPhone 12, iOS 17.6, Safari). Confirmation email arrived after 9 minutes, expected under 2 · evidence https://drive.example.com/gibreview/ada_qa/tc-03.mp4
- **PASS** by @tunde.tests (iPhone SE (2nd gen), iOS 16.7, Safari). email arrived in about 40 seconds

## Tester ledger

| Tester | Bounty | Device | Parse verdict | Review | Payout | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| @quickcash99 | android-chrome-1 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | android-chrome-1 | Samsung Galaxy A14, Android 14, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | android-chrome-1 | Tecno Spark 20, Android 13, Chrome 128 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | android-chrome-1 | Infinix Hot 40i, Android 13, Chrome 129 | incomplete | rejected |  | Missing results for TC-05; TC-02 is FAIL without an evidence link |
| @quickcash99 | android-chrome-2 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | android-chrome-2 | Samsung Galaxy A14, Android 14, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | android-chrome-2 | Tecno Spark 20, Android 13, Chrome 128 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | android-chrome-2 | Infinix Hot 40i, Android 13, Chrome 129 | incomplete | rejected |  | Missing results for TC-07 |
| @quickcash99 | desktop-1 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | desktop-1 | ThinkPad T480, Windows 11, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | desktop-1 | MacBook Air M1, macOS 14, Firefox 131 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | desktop-1 | Dell Latitude, Ubuntu 24.04, Chrome 129 | incomplete | rejected |  | Missing results for TC-05 |
| @quickcash99 | desktop-2 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | desktop-2 | ThinkPad T480, Windows 11, Chrome 129 | valid | approved | 2.00 USDC |  |
| @tunde.tests | desktop-2 | MacBook Air M1, macOS 14, Firefox 131 | valid | approved | 2.00 USDC |  |
| @kemi_bugs | desktop-2 | Dell Latitude, Ubuntu 24.04, Chrome 129 | incomplete | rejected |  | Missing results for TC-08 |
| @quickcash99 | ios-safari-1 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | ios-safari-1 | iPhone 12, iOS 17.6, Safari | valid | approved | 2.00 USDC |  |
| @tunde.tests | ios-safari-1 | iPhone SE (2nd gen), iOS 16.7, Safari | valid | approved | 2.00 USDC |  |
| @kemi_bugs | ios-safari-1 | iPhone 14, iOS 18.0, Safari | incomplete | rejected |  | Missing results for TC-05 |
| @quickcash99 | ios-safari-2 |  | invalid | rejected |  | No result block found. Use the QA RESULT template from the bounty. |
| @ada_qa | ios-safari-2 | iPhone 12, iOS 17.6, Safari | valid | approved | 2.00 USDC |  |
| @tunde.tests | ios-safari-2 | iPhone SE (2nd gen), iOS 16.7, Safari | valid | approved | 2.00 USDC |  |
| @kemi_bugs | ios-safari-2 | iPhone 14, iOS 18.0, Safari | incomplete | rejected |  | Missing results for TC-07 |

## Bounties

- `android-chrome-1` [QA] Acme Shop checkout regression v2.3.0 on Android phone (Chrome) (part 1/2) · 5 cases · task 71b39a1a-fff3-4776-a615-9750cd987e1f · tx 042029f3300d9130c3480efa03b5403b83225b129cee
- `android-chrome-2` [QA] Acme Shop checkout regression v2.3.0 on Android phone (Chrome) (part 2/2) · 2 cases · task 73fe8410-72ed-471a-b24e-93d88c07b930 · tx 5d3f5b34b02b1f327dd9d4814c6cf5c19f9ccb453d16
- `ios-safari-1` [QA] Acme Shop checkout regression v2.3.0 on iPhone (Safari) (part 1/2) · 5 cases · task 0c145289-ca52-4cc8-a294-6748fe70ffd5 · tx b087be3a67ec6e373e228c96e15bd98f9490d2344d23
- `ios-safari-2` [QA] Acme Shop checkout regression v2.3.0 on iPhone (Safari) (part 2/2) · 2 cases · task 9654bc4a-4053-457e-8028-a0968a0ceb92 · tx 8fbb584199066172580aa572252fdb4a9ef968011352
- `desktop-1` [QA] Acme Shop checkout regression v2.3.0 on Desktop browser (part 1/2) · 5 cases · task 8d9139cf-5c7e-476e-a0cf-b15b27dc8596 · tx dce6c05bc50a6e83e72aaa4764cd25aa562c8faa6954
- `desktop-2` [QA] Acme Shop checkout regression v2.3.0 on Desktop browser (part 2/2) · 2 cases · task 5937d7f2-82e6-45d0-a949-ca2616d04707 · tx 2eaf69806608e18e0660175d0eba007be4473fed95bd

Generated by gibreview using the Gibwork SDK.