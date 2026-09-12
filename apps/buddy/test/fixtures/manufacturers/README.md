# Manufacturer parser fixtures

Table excerpts from manufacturer sources checked 2026-09-08. HTML fixtures preserve merged cells; JSON fixtures preserve PDF page and cell geometry from pdfplumber 0.11.9. These are test inputs, not independent product measurements. Full original-source hashes follow.

- `rolls-s6.html`: [S6 L16-HC source](https://rollsbattery.com/battery/s6-l16-hc/), SHA-256 `95a7dccd489757392296e5537d297e7e9b6bbce7c61c0a76205beea01ef5d6aa`.
- `rolls-r36.html`: [R36-100LFP source](https://rollsbattery.com/battery/r36-100lfp/), SHA-256 `97c1ce785bdacd0fa59309ae93e4c7b19aa6ffca6d76572db9ff10183a6951ee`.
- `victron.html`: [SmartSolar MPPT source](https://www.victronenergy.com/media/pg/Manual_SmartSolar_MPPT_150-70_up_to_250-100_VE.Can/en/technical-specifications.html), SHA-256 `37ef7205b98bb557c5cbf38f811ade7bb8eb60dd6f6ef209518197840c5f90f5`.
- `ipower-plus.json`: [IPower Plus source](https://www.epever.com/wp-content/uploads/2021/05/IPower-Plus-Manual-EN-V3.3.pdf), SHA-256 `84760a915182fcce39c94e2af6c1abaa4caacd4c10653b211a6eb7f03cd2cf92`.
- `xtra.json`: [XTRA N source](https://www.epever.com/wp-content/uploads/2021/04/XTRA-N-Manual-EN-V4.5ETL.pdf), SHA-256 `b98127da37c03fb7adf05c2f0dbf5c2ebb18af07641a023d24b43889340f414d`.
- `duoracer.json`: [DuoRacer source](https://www.epever.com/wp-content/uploads/2021/05/DuoRacer-Manual-EN-V2.5.pdf), SHA-256 `f605741c80467647ab168f56ec9981728730ec77a6025acabcc876f95c896e6f`.
- `us-battery-2200.html`: [US 2200 XC2 source](https://www.usbattery.com/us-2200-xc2/), SHA-256 `c8c78a8475a225c61a095caa574ecfaad57eadc037a8822cd59f1d9170fd4e5e`. Heading, comparison table and data-sheet link only.
- `morningstar-tristar-mppt.html`: [TriStar MPPT source](https://www.morningstarcorp.com/products/tristar-mppt/), SHA-256 `fb34b69c3eb1998e943496f0be24cf60107c0b6ded577d061d8d7ad01fc63d35`.
- `morningstar-genstar.html`: [GenStar MPPT source](https://www.morningstarcorp.com/products/genstar-mppt/), SHA-256 `5ba0d1b725a9bf290cb0ff520dd3e1db980036af9ec1e4f5c6a6428ab1076ba2`. The model row is images; kept as the rejection case.
- `yilink-w48200.html`: [YL-W48200 source](https://www.yilink.ca/en/products/w48200/), SHA-256 `db6e7404a6ef708c3a2a8e440d7225393689a3a2bb544f6e4a616205a37e5e28`. Model label, caption and technical table only.
- `yilink-lfp-abs.html`: [LFP-ABS family source](https://www.yilink.ca/en/products/lfp-abs/), SHA-256 `906c039eeaef94887a2c7f1c8240653dcd7a4e21566a324a58cc0a600f12fee7`. A family page, kept as the rejection case.
- `duromax-feed.json`: [products feed page 1](https://www.duromaxpower.com/products.json?limit=250&page=1), SHA-256 `3c0c9a7b430fca99ddd53054506cd8fa39c3a9f249a99fc1ce4066da95b5decb`. Two generators and one cover, bodies trimmed to the specification tables.
- `discover-42-48-6650.html`: [42-48-6650 source](https://discoverbattery.com/products/search/42-48-6650), SHA-256 `4578045a8959738b20a3fd6bb6e02d7e5935194b61319e4b57d0fdabc52e196a`. Title and the product-tab tables only.
- `volthium-12v-100ah-gr24.json`: [fiche technique 12 V 100 Ah GR24](https://volthium.com/wp-content/uploads/2026/02/Fiche-Technique-2025_12-V-100-Ah-GR24.pdf), SHA-256 `e1d7ecedb73c340cb422c11d3c056495a54a36f10f5f9f7a50853c0a99a9d05f`. Text lines of page 2 from pdf-lines.py.
- `volthium-12v-200ah-2024.json`: [fiche technique 12 V 200 Ah (2024 layout)](https://volthium.com/wp-content/uploads/2024/04/Fiche-Technique_12V-200AH.pdf), SHA-256 `396872d01e9080dc1a48d3fd7fec5947cf2cc5159f9bd9fd0acfa4d38dfd2617`. Two-column layout, page 2.
- `solark-15k.json`: [15K-2P-LV datasheet](https://sol-ark.com/wp-content/uploads/2024/06/15K-2P-LV_Datasheet_Rev_7_16July2026.pdf), SHA-256 `488813d29230d2477a10368f2f72ad2ce428c317d432cb9dac016320a40c251e`. Page 2, the one whose header the figure legend garbles.
- `samlex-pst-2000.json`: [PST-2000 specification sheet](https://samlexamerica.com/wp-content/uploads/2026/07/12001-PST-2000-12-24-48-0826.pdf), SHA-256 `335a6eab57679e93295eb39d71b7399750ba23db6093dfccce9932367bd040a4`.
- `outback-fxr-a.json`: [FXR/VFXR A spec sheet](https://outbackpower.com/downloads/documents/inverter_chargers/fxr_vfxr_a/FXR_A_specsheet.pdf), SHA-256 `ccba60f4c8fc2a1201959ccd943c5aba3a14169ab2885f169e1fd88a1d1ca430`.
- `schneider-xw-pro.json`: [Conext XW Pro UL datasheet](https://solar.se.com/us/wp-content/uploads/sites/7/2021/10/XW-Pro-UL-Datasheet.pdf), SHA-256 `f01b4934f60e9d426a52b236629f46bc5188441eb5f6bffb92854a56e1d24a48`. Page 2.
