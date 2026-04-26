use calamine::*;
use std::path::Path;

fn main() {
    let path = r"C:\Users\Administrator\Desktop\焚烧区\销售主题分析_多维分析_20260426204227_157744108_1.xlsx";
    let mut workbook = open_workbook_auto(path).unwrap();
    for name in workbook.sheet_names() {
        println!("Sheet: {}", name);
        let range = workbook.worksheet_range(&name).unwrap().unwrap();
        println!("  start={:?} end={:?}", range.start(), range.end());
        
        // Check merged cells
        if let Some(merged) = workbook.worksheet_merge_cells(&name) {
            println!("  Merged cells: {:?}", merged);
        }
        
        // Print first 3 rows with cell types
        for (i, row) in range.rows().take(3).enumerate() {
            let cells: Vec<String> = row.iter().map(|c| {
                match c {
                    Data::Empty => "EMPTY".to_string(),
                    Data::String(s) => format!("STR:{}", s),
                    Data::Float(f) => format!("FLOAT:{}", f),
                    Data::Int(i) => format!("INT:{}", i),
                    Data::Bool(b) => format!("BOOL:{}", b),
                    Data::DateTime(d) => format!("DT:{}", d),
                    Data::Duration(d) => format!("DUR:{}", d),
                    Data::Error(e) => format!("ERR:{:?}", e),
                }
            }).collect();
            println!("  Row {}: {:?}", i, &cells[..15.min(cells.len())]);
        }
    }
}
