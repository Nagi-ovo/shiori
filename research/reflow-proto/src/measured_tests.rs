use super::*;
fn tokens(count: usize) -> Vec<Token> {
    (0..count)
        .map(|i| Token {
            text: "甲".into(),
            advance: 5.,
            gap: 0.,
            source: Some(i),
            font: "pdf-code-font".into(),
            gid: None,
            ink: [0., -1., 5., 4.],
            pdf_error: Some(0.),
            raw_error: None,
            fallback: false,
        })
        .collect()
}
fn slots(lefts: &[f64]) -> Vec<LineSlot> {
    lefts
        .iter()
        .enumerate()
        .map(|(i, left)| LineSlot {
            left: *left,
            right: 70.,
            baseline: 700. - i as f64 * 14.,
        })
        .collect()
}
#[test]
fn flush_and_first_line_indent_have_different_breaks_and_origins() {
    let t = tokens(8);
    let flush = break_measured(&t, &slots(&[50., 50., 50.])).unwrap();
    assert_eq!(flush.ranges, [(0, 4), (4, 8)]);
    assert_eq!(flush.origins[0], Some([50., 700.]));
    let indented = break_measured(&t, &slots(&[60., 50., 50.])).unwrap();
    assert_eq!(indented.ranges, [(0, 2), (2, 6), (6, 8)]);
    assert_eq!(indented.origins[0], Some([60., 700.]));
    assert_eq!(indented.origins[2], Some([50., 686.]));
    assert_eq!(indented.origins[6], Some([50., 672.]));
}
#[test]
fn hanging_indent_uses_wider_first_line_and_body_left_after_wrap() {
    let out = break_measured(&tokens(8), &slots(&[40., 50., 50.])).unwrap();
    assert_eq!(out.ranges, [(0, 6), (6, 8)]);
    assert_eq!(out.origins[0], Some([40., 700.]));
    assert_eq!(out.origins[6], Some([50., 686.]));
}
#[test]
fn no_invented_baseline_for_overflow() {
    let out = break_measured(&tokens(9), &slots(&[60., 60., 60.])).unwrap();
    assert_eq!(out.ranges.len(), 5);
    assert_eq!(out.origins[6], None);
    assert_eq!(out.origins[8], None);
}
#[test]
fn pdf_widths_and_source_kern_gaps_drive_breaking() {
    let mut t = tokens(5);
    // Widths supplied by TS, independent of a GID/program advance.
    for token in &mut t {
        token.advance = 4.;
        token.ink[2] = 4.;
    }
    assert_eq!(
        break_measured(&t, &slots(&[50., 50.])).unwrap().ranges,
        [(0, 5)]
    );
    t[0].gap = 2.;
    let out = break_measured(&t, &slots(&[50., 50.])).unwrap();
    assert_eq!(out.ranges, [(0, 4), (4, 5)]);
    assert_eq!(out.origins[1], Some([56., 700.]));
}
#[test]
fn invalid_slots_clusters_and_rtl_refuse() {
    assert!(break_measured(&tokens(1), &[]).is_err());
    assert!(break_measured(&tokens(1), &slots(&[70.])).is_err());
    let mut s = slots(&[50.]);
    s[0].baseline = f64::NAN;
    assert!(break_measured(&tokens(1), &s).is_err());
    let mut t = tokens(1);
    t[0].advance = f64::INFINITY;
    assert!(break_measured(&t, &slots(&[50.])).is_err());
    t = tokens(1);
    t[0].text = "שלום".into();
    assert!(break_measured(&t, &slots(&[50.])).is_err());
}
#[test]
fn unbreakable_cluster_is_an_explicit_break_failure() {
    let mut t = tokens(1);
    t[0].advance = 100.;
    assert!(break_measured(&t, &slots(&[50.])).unwrap().break_failure);
}
