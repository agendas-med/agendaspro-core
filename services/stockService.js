const functions = require("../utils/functions");

// Quantidade: inteiro positivo (limite defensivo).
function parseQuantity(quantity) {
    const value = Number(quantity);
    if (typeof quantity === "boolean" || !Number.isSafeInteger(value) || value <= 0 || value > 1000000) return null;
    return value;
}

let stockService = {
    returnStock: function (company_id) {
        return functions.executeSql(
            `
                SELECT
                    p.id,
                    p.name AS produto,
                    CASE WHEN p.current_stock = 0 THEN "Vazio" ELSE "Normal" END AS status,
                    CONCAT(p.current_stock, " ", um.abbreviation) AS quantidade
                FROM
                    products p
                LEFT JOIN
                    units_of_measurement um ON um.id = p.unit_of_measure
                WHERE
                    p.company_id = ?
            `, [company_id]
        );
    },
    // Movimenta estoque apenas de produto da empresa; saída não deixa saldo negativo.
    move: async function (company_id, product_id, quantity, type) {
        const qty = parseQuantity(quantity);
        if (!qty) throw "Quantidade inválida. Informe um número inteiro maior que zero.";
        const productId = Number(product_id);
        if (!Number.isSafeInteger(productId) || productId <= 0) throw "Produto inválido.";
        await functions.executeTransaction(async (query) => {
            const sql = type === "add"
                ? "UPDATE products SET current_stock = current_stock + ? WHERE id = ? AND company_id = ?"
                : "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND company_id = ? AND current_stock >= ?";
            const params = type === "add" ? [qty, productId, company_id] : [qty, productId, company_id, qty];
            const result = await query(sql, params);
            if (result.affectedRows !== 1) {
                const exists = await query("SELECT 1 FROM products WHERE id = ? AND company_id = ?", [productId, company_id]);
                throw exists.length ? "Estoque insuficiente." : "Produto não encontrado.";
            }
            await query("INSERT INTO stock_movements (product_id, quantity, type) VALUES (?, ?, ?)", [productId, qty, type]);
        });
    },
    add: function (company_id, product_id, quantity) {
        return this.move(company_id, product_id, quantity, "add");
    },
    remove: function (company_id, product_id, quantity) {
        return this.move(company_id, product_id, quantity, "remove");
    }
}

module.exports = stockService;
