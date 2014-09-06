var Sequelize = require('sequelize');
var odataParser = require('breeze-odataparser');
var url = require("url");

module.exports = queryTranslator;

var boolOpMap = {
  eq: { jsOp: "==="},
  gt: { sequelizeOp: "gt",  jsOp: ">" },
  ge: { sequelizeOp: "gte", jsOp: ">=" },
  lt: { sequelizeOp: "lt",  jsOp: "<" },
  le: { sequelizeOp: "lte", jsOp: "<=" },
  ne: { sequelizeOp: "ne",  jsOp: "!=" }
}

// pass in either a query string or a urlQuery object
//    a urlQuery object is what is returned by node's url.parse(aUrl, true).query;
function queryTranslator(query) {
  var section;
  var urlQuery = (typeof(query) === 'string') ? url.parse(query, true).query : query;

  section = urlQuery.$filter;
  if (section) {
    var filterTree = parse(section, "filterExpr");
    var context = {
      translateMember: function(memberPath) {
        return memberPath.replace("/", ".");
      }
    };
    this.filter = toQueryExpr(filterTree, context);
  }

  section = urlQuery.$select;
  if (section) {
    var selectItems = parse(section, "selectExpr");

  }

  section = urlQuery.$expand;
  if (section) {

  }

  section = urlQuery.$orderby;
  if (section) {
    var orderbyItems = parse(section, "orderbyExpr");

  }

  section = urlQuery.$top;
  // not ok to ignore top: 0
  if (section !== undefined) {

  }

  section = urlQuery.$skip;
  // ok to ignore skip: 0
  if (section) {

  }

  section = urlQuery.$inlinecount;
  this.inlineCount = !!(section && section !== "none");

}



function parse(text, sectionName) {
  try {
    return odataParser.parse(text, sectionName);
  } catch(e) {
    var err = new Error("Unable to parse " + sectionName + ": " + text);
    err.statusCode = 400;
    err.innerError = e;
    throw err;
  }
}

function toOrderbyExpr(orderbyItems) {
  // "sort": [['field1','asc'], ['field2','desc']]

  var sortItems = orderbyItems.map(function(s) {
    var sPath = s.path.replace("/",".");
    return [sPath,  s.isAsc ? "asc" : "desc"];
  }) ;
  return { sort: sortItems };
}

function toSelectExpr(selectItems) {
  var result = {};
  selectItems.forEach(function(s) {
    var sPath = s.replace("/",".");
    result[sPath] = 1;
  }) ;
  return result;
}

function toQueryExpr(node, context) {
  if (node.type === "op_bool") {
    return makeBoolFilter(node, context);
  } else if (node.type === "op_andOr") {
    return makeAndOrFilter(node, context);
  } else if (node.type === "fn_2") {
    return makeFn2Filter(node, context);
  } else if (node.type === "op_unary") {
    return makeUnaryFilter(node, context);
  } else if (node.type === "op_anyAll") {
    return makeAnyAllFilter(node, context);
  } else {
    throw new Error("Unable to parse node: " + node.type)
  }
}

function makeBoolFilter(node, context) {
  var q = {};
  var op = node.op;
  var p1 = node.p1;
  var p2 = node.p2;
  var p1Value = parseNodeValue(p1, context);
  var p2Value = parseNodeValue(p2, context);

  if (p1.type === "member") {
    if (startsWith(p2.type, "lit_")) {
      if (op === "eq") {
        q[p1Value] = p2Value;
      } else {
        var mop = boolOpMap[op].sequelizeOp;
        var crit = {};
        crit[mop] = p2Value;
        q[p1Value] = crit;
      }
      return q;
    } else if (p2.type === "member") {
      var val = sequelize.col(p2Value);
      if (op === "eq") {
        q[p1Value] = val;
      } else {
        var mop = boolOpMap[op].sequelizeOp;
        var crit = {};
        crit[mop] = val;
        q[p1Value] = crit;
      }
      return q;
    }
  } else if (p2.type === "lit_boolean") {
    var q = toQueryExpr(p1, context);
    if (p2Value === true) {
      return q;
    } else {
      return applyNot(q);
    }
  }
  throw new Error("Not yet implemented: Boolean operation: " + op + " p1: " + stringify(p1) + " p2: " + stringify(p2));
}

function makeUnaryFilter(node, context) {
  var op = node.op;
  var p1 = node.p1;
  var q1 = toQueryExpr(p1, context);

  if (op === "not ") {
    return applyNot(q1);
  }
  throw new Error("Not yet implemented: Unary operation: " + op + " p1: " + stringify(p1));
}


function makeFn2Filter(node, context) {
  var fnName = node.name;
  var p1 = node.p1;
  var p2 = node.p2;
  var q = {};

  var p1Value = parseNodeValue(p1, context);
  var p2Value = parseNodeValue(p2, context);

  if (p1.type === "member") {
    // TODO: need to handle nested paths. '/' -> "."

    if (startsWith(p2.type, "lit_")) {
      if (fnName === "startswith") {
        q[p1Value] =  new RegExp("^" +p2Value, 'i' ) ;
      }   else if (fnName === "endswith") {
        q[p1Value] =  new RegExp( p2Value + "$", 'i');
      }
    } else if (p2.type === "member") {
      var fn;
      if (fnName === "startswith") {
        fn =  "(new RegExp('^' + this." + p2Value + ",'i')).test(this." +  p1Value + ")";
        addWhereClause(q, fn);
      }   else if (fnName === "endswith") {
        fn =  "(new RegExp(this." + p2Value + " + '$','i')).test(this." +  p1Value + ")";
        addWhereClause(q, fn);
      }
    }
  } else if (fnName === "substringof") {
    if (p1.type === "lit_string" && p2.type === "member") {
      q[p2Value] = new RegExp(p1Value, "i");
    }
  }

  if (!isEmpty(q)) {
    return q;
  }
  throw new Error("Not yet implemented: Function: " + fnName + " p1: " + stringify(p1) + " p2: " + stringify(p2));
}

function makeAndOrFilter(node, context) {

  var q1 = toQueryExpr(node.p1, context);
  var q2 = toQueryExpr(node.p2, context);
  var q;
  if (node.op === "and") {
    // q = extendQuery(q1, q2);
    q = { "$and": [q1, q2] };
  } else {
    q = { "$or": [q1, q2] };
  }
  return q;
}

function makeAnyAllFilter(node, context) {
  var lambda = node.lambda;
  var newContext = {
    translateMember: function(memberPath) {
      return context.translateMember(memberPath.replace(lambda + "/", ""));
    }
  }
  return (node.op === "any") ? makeAnyFilter(node, newContext) : makeAllFilter(node, newContext);
}

function makeAnyFilter(node, context) {
  var subq = toQueryExpr(node.subquery, context);
  var q = {};
  var key = context.translateMember(node.member);
  q[key] = { "$elemMatch" : subq } ;
  return q;
}

function makeAllFilter(node, context) {
  var subq = toQueryExpr(node.subquery, context);
  var notSubq = applyNot(subq);
  var q = {};
  var key = context.translateMember(node.member);
  q[key] = { $not: { "$elemMatch" : notSubq } } ;
  q[key + ".0"] = { $exists: true };
  return q;
}

function parseNodeValue(node, context) {
  if (!node) return null;
  if (node.type === "member") {
    return context.translateMember(node.value);
  } else if (node.type === "lit_string" ) {
    return parseLitString(node.value);
  } else {
    return node.value;
  }
}

function applyNot(q1) {
  // because of the #@$#1 way mongo defines $not - i.e. can't apply it at the top level of an expr
  // and / or code gets ugly.
  // rules are:
  // not { a: 1}             -> { a: { $ne: 1 }}
  // not { a: { $gt: 1 }}    -> { a: { $not: { $gt: 1}}}
  // not { $and { a: 1, b: 2 } -> { $or:  { a: { $ne: 1 }, b: { $ne 2 }}}
  // not { $or  { a: 1, b: 2 } -> { $and: [ a: { $ne: 1 }, b: { $ne 2 }]}

  var results = [];
  for (var k in q1) {
    var v = q1[k];
    if (k === "$or") {
      result = { $and: [ applyNot(v[0]), applyNot(v[1]) ] }
    } else if (k === "$and") {
      result = {  $or: [ applyNot(v[0]), applyNot(v[1]) ] }
    } else {
      result = {};
      if ( v!=null && typeof(v) === "object") {
        result[k] = { $not: v };
      } else {
        result[k] = { "$ne": v };
      }
    }

    results.push(result);
  }
  if (results.length === 1) {
    return results[0];
  } else {
    // Don't think we should ever get here with the current logic because all
    // queries should only have a single node
    return { "$or": results };
  }
}

function addWhereClause(q, whereClause) {
  whereClause = "(" + whereClause + ")";
  var whereFn = wherePrefix + whereClause + whereSuffix;
  q.$where = whereFn;
  return q;
}

function startsWith(str, prefix) {
  // returns false for empty strings too
  if ((!str) || !prefix) return false;
  return str.indexOf(prefix, 0) === 0;
}

function parseLitString(s) {
  if (/^[0-9a-fA-F]{24}$/.test(s)) {
    return new ObjectId(s);
  } else {
    return s;
  }
}

function stringify(node) {
  return JSON.stringify(node);
}