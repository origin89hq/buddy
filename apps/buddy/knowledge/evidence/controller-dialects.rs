//! The register maps of actual devices.
//!
//! Every block here is a `const`, so the compiler checks it against the registry
//! on the way in: a register wired to the wrong unit, or running past the end of
//! the read it belongs to, is a build failure rather than a wrong number at an
//! unattended site.
//!
//! A dialect covers exactly what a document in `docs/vendor/frames/` attests and
//! not one register more. Where a device publishes something the registry has no
//! name for, that is said out loud rather than mapped to the nearest thing —
//! a wattage filed under the wrong kind is worse than a wattage nobody reads.

use km43_proto::MetricKind;

use crate::map::{Block, Cell, Sign, Span};
use crate::scale::Published;

/// PZEM-003 and PZEM-017 DC energy meters.
///
/// The whole map is one read of eight input registers, and every one of them is
/// worked through in the manual's own example — which is why this is the first
/// dialect: nothing in it is inferred.
pub mod pzem_dc {
    use super::{Block, Cell, MetricKind, Published, Sign, Span};

    /// Hundredths of a volt, as the meter publishes them.
    const VOLTS: Published = Published {
        unit: "V",
        decade: -2,
    };
    /// Hundredths of an amp.
    const AMPS: Published = Published {
        unit: "A",
        decade: -2,
    };
    /// Tenths of a watt.
    const WATTS: Published = Published {
        unit: "W",
        decade: -1,
    };

    /// The first register of the block.
    pub const FROM: u16 = 0x0000;

    /// How many registers one read asks for.
    pub const QUANTITY: u16 = 8;

    /// The three values this meter publishes that the registry has a name for.
    ///
    /// **The current is unsigned.** A PZEM-017 measures through a shunt in one
    /// direction and its manual gives no sign convention, so a bank being
    /// emptied does not appear here at all — it reads as no current rather than
    /// as a negative one. That is a limit of the instrument, and a behaviour
    /// that needs to know a bank is discharging must not be wired to this meter.
    ///
    /// Not mapped, because the registry has no kind for them: the energy total
    /// at `0x0004`/`0x0005` (the `Wh` kind the registry publishes is on an AC
    /// channel, and filing a DC meter's energy there would be a different
    /// measurement wearing the right unit), and the two alarm flags at `0x0006`
    /// and `0x0007`, which are not measurements at all.
    pub const REAL_TIME: Block = match Block::checked(
        FROM,
        QUANTITY,
        &[
            Cell {
                at: 0x0000,
                kind: MetricKind::DC_VOLTAGE,
                span: Span::One,
                sign: Sign::Unsigned,
                published: VOLTS,
                absent: None,
            },
            Cell {
                at: 0x0001,
                kind: MetricKind::DC_CURRENT,
                span: Span::One,
                sign: Sign::Unsigned,
                published: AMPS,
                absent: None,
            },
            Cell {
                at: 0x0002,
                kind: MetricKind::DC_POWER,
                span: Span::TwoLowFirst,
                sign: Sign::Unsigned,
                published: WATTS,
                absent: None,
            },
        ],
    ) {
        Ok(block) => block,
        Err(_) => panic!("the `PZEM` block must agree with the registry"),
    };
}

/// `EPEver` LS-B, VS-B and Tracer-B series controllers.
///
/// **One register.** `docs/vendor/frames/epever-b-series-v2.3.txt` is the only
/// document in this repository that prints real check bytes, and the single
/// exchange it works through is the battery voltage at `0x3104`. The rest of the
/// 0x3100 block is real and well known, and none of it is transcribed here,
/// because a scale written down from memory and filed under a vendor's name is a
/// worse artefact than no artefact — it reads as evidence and is not.
///
/// This grows when somebody puts the register table from the specification into
/// `docs/vendor/frames/`, and not before.
pub mod epever_b {
    use super::{Block, Cell, MetricKind, Published, Sign, Span};

    /// The first register of the real-time block.
    pub const FROM: u16 = 0x3104;

    /// How many registers one read asks for.
    pub const QUANTITY: u16 = 1;

    /// The battery voltage, in hundredths of a volt.
    pub const REAL_TIME: Block = match Block::checked(
        FROM,
        QUANTITY,
        &[Cell {
            at: 0x3104,
            kind: MetricKind::DC_VOLTAGE,
            span: Span::One,
            sign: Sign::Unsigned,
            published: Published {
                unit: "V",
                decade: -2,
            },
            absent: None,
        }],
    ) {
        Ok(block) => block,
        Err(_) => panic!("the EPEver battery voltage must agree with the registry"),
    };
}

#[cfg(test)]
mod tests {
    use super::{epever_b, pzem_dc};
    use km43_proto::MetricKind;
    use o89_modbus::{ReadFn, Request, SlaveAddr, crc, trailer};

    const PZEM_DOC: &str = include_str!("../../../docs/vendor/frames/pzem-dc-003-017.txt");
    const EPEVER_DOC: &str = include_str!("../../../docs/vendor/frames/epever-b-series-v2.3.txt");

    /// The bytes of a named line in a committed vendor document.
    ///
    /// Read rather than retyped: move `docs/vendor/frames/` and every test below
    /// stops compiling, which is the whole point of the artefact existing.
    fn bytes(doc: &str, block: &str, kind: &str) -> ([u8; 64], usize) {
        let mut inside = false;
        for line in doc.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                inside = name == block;
                continue;
            }
            let Some(rest) = line.strip_prefix(kind).and_then(|l| l.strip_prefix(':')) else {
                continue;
            };
            if !inside {
                continue;
            }
            let mut out = [0_u8; 64];
            let mut len = 0;
            for pair in rest.split_whitespace() {
                out[len] = u8::from_str_radix(pair, 16).expect("pairs of hex");
                len += 1;
            }
            return (out, len);
        }
        panic!("no {kind} in [{block}]");
    }

    /// Every `means:` line of a block, so a scale can be checked against the
    /// sentence the vendor wrote rather than against this module's opinion.
    fn meanings<'a>(doc: &'a str, block: &str) -> ([&'a str; 16], usize) {
        let mut out = [""; 16];
        let mut len = 0;
        let mut inside = false;
        for line in doc.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                inside = name == block;
                continue;
            }
            if !inside {
                continue;
            }
            if let Some(rest) = line.strip_prefix("means:") {
                out[len] = rest.trim();
                len += 1;
            }
        }
        (out, len)
    }

    /// Re-check a reply's CRC so a document whose check bytes are placeholders
    /// can still drive the codec.
    fn with_check(frame: &[u8], len: usize) -> ([u8; 64], usize) {
        let mut out = [0_u8; 64];
        out[..len].copy_from_slice(&frame[..len]);
        let sum = trailer(crc(&out[..len]));
        out[len] = sum[0];
        out[len + 1] = sum[1];
        (out, len + 2)
    }

    /// **The manual's own worked example decodes to the numbers it prints.**
    ///
    /// A hundred volts, one amp and a hundred watts, out of the bytes the vendor
    /// published, through the block this controller will actually use. Change
    /// any byte of that frame and this test changes with it.
    #[test]
    fn the_pzem_manuals_worked_example_reads_as_the_numbers_it_prints() {
        let (frame, len) = bytes(PZEM_DOC, "read-all-eight-input-registers", "reply");
        let (frame, len) = with_check(&frame, len);
        let request = Request::read(
            SlaveAddr::new(0x01).expect("an address"),
            ReadFn::InputRegisters,
            pzem_dc::FROM,
            pzem_dc::QUANTITY,
        )
        .expect("a legal read");
        let words = request
            .reply(&frame[..len])
            .expect("the vendor's own reply");

        assert_eq!(
            pzem_dc::REAL_TIME.value(0, &words).took(),
            Some((MetricKind::DC_VOLTAGE, 100_000)),
            "100.00 V in millivolts"
        );
        assert_eq!(
            pzem_dc::REAL_TIME.value(1, &words).took(),
            Some((MetricKind::DC_CURRENT, 1_000)),
            "1.00 A in milliamps"
        );
        assert_eq!(
            pzem_dc::REAL_TIME.value(2, &words).took(),
            Some((MetricKind::DC_POWER, 1_000)),
            "100.0 W in tenths of a watt"
        );
    }

    /// **The scales this module declares are the ones the document states.**
    ///
    /// The decode above would pass just as well with the scale and the registry
    /// both wrong in the same direction. This reads the vendor's sentence.
    #[test]
    fn the_scales_this_dialect_declares_are_the_ones_the_document_states() {
        let (lines, count) = meanings(PZEM_DOC, "read-all-eight-input-registers");
        assert_eq!(count, 6, "the document works through six registers");

        for (register, expected) in [
            (0x0000_u16, "counts of 0.01 V"),
            (0x0001, "counts of 0.01 A"),
            (0x0002, "counts of 0.1 W"),
        ] {
            let prefix = match register {
                0x0002 => "0x0002/0x0003",
                other => {
                    assert!(other < 2, "only the single registers take this branch");
                    if other == 0 { "0x0000" } else { "0x0001" }
                }
            };
            let line = lines
                .iter()
                .take(count)
                .find(|l| l.starts_with(prefix))
                .unwrap_or_else(|| panic!("no meaning for {register:#06x}"));
            assert!(
                line.contains(expected),
                "the document says {line:?}, which is not {expected:?}"
            );
        }

        // And the word order, which is the difference between a hundred watts
        // and sixty-five million.
        let power = lines
            .iter()
            .take(count)
            .find(|l| l.starts_with("0x0002/0x0003"))
            .expect("the power line");
        assert!(
            power.contains("low-word-first"),
            "the block reads the power low word first and the document must agree"
        );
    }

    /// The `EPEver` document's single worked exchange, through the block that
    /// covers it.
    #[test]
    fn the_epever_manuals_worked_example_is_twelve_point_three_volts() {
        let (frame, len) = bytes(EPEVER_DOC, "read-real-time-battery-voltage", "reply");
        let request = Request::read(
            SlaveAddr::new(0x01).expect("an address"),
            ReadFn::InputRegisters,
            epever_b::FROM,
            epever_b::QUANTITY,
        )
        .expect("a legal read");
        let words = request
            .reply(&frame[..len])
            .expect("the vendor's own reply");

        assert_eq!(
            epever_b::REAL_TIME.value(0, &words).took(),
            Some((MetricKind::DC_VOLTAGE, 12_300)),
            "12.3 V in millivolts"
        );
    }

    /// **The request this dialect builds is the one the vendor prints.**
    ///
    /// The block declares the address and the count, so if either drifts the
    /// bytes on the wire stop matching the document.
    #[test]
    fn the_request_this_dialect_builds_is_the_one_the_vendor_prints() {
        let (want, len) = bytes(EPEVER_DOC, "read-real-time-battery-voltage", "request");
        let request = Request::read(
            SlaveAddr::new(0x01).expect("an address"),
            ReadFn::InputRegisters,
            epever_b::FROM,
            epever_b::QUANTITY,
        )
        .expect("a legal read");
        let mut sent = [0_u8; o89_modbus::REQUEST_BYTES];
        request.encode(&mut sent).expect("room");
        assert_eq!(&sent[..], &want[..len]);
    }

    /// A dialect covers what a document attests and not one register more. The
    /// `EPEver` block is one register because one exchange is what that document
    /// works through — if this ever fails, the artefact grew and the doc comment
    /// on `epever_b` needs to grow with it.
    #[test]
    fn a_dialect_claims_only_what_its_document_attests() {
        assert_eq!(
            epever_b::REAL_TIME.len(),
            1,
            "the `EPEver` document works through exactly one exchange"
        );
        let (_, epever_means) = meanings(EPEVER_DOC, "read-real-time-battery-voltage");
        assert_eq!(epever_means, 1);

        assert_eq!(
            pzem_dc::REAL_TIME.len(),
            3,
            "three of the `PZEM`'s six documented registers have a kind in the registry"
        );
    }
}
