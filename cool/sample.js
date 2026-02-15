let l = [[1,[3,4,[78,-1],11,14],87],24,67]

/*

[1,3,4,78,-1]

arr and -> [1,[3,4,[78,-1],11,14],87]
                     |
                     |
                     |
                     V
                     
            [3,4,[78,-1],11,14]
                    |
                    |
                    |
                    V

                [78,-1] (ok)

*/

const flattenArray = (arr, v = []) => {
    // var v = [];
    if(typeof arr != "number") {
        for(let i of arr){
            if(typeof i === "object") {
                v.concat(flattenArray(i,v));
            }else {
                v.push(i);
            }
        }
    }
    // v.push()
    return v;
}

// console.log(l);
let v = []

// console.log(v);
v = flattenArray(l);
console.log(v);
