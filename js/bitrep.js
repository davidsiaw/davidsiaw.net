console.log ('hello')

// float formats
var expobit = {}
expobit[8] = [3];   // 4-bit exponent
expobit[16] = [10]; // half float
expobit[24] = [16]; // 7-bit exponent
expobit[32] = [23]; // single float
expobit[64] = [52]; // double float


var szs = [8,16,24,32,64];

for(var szi=0;szi<szs.length;szi++)
{
  var bitcount = szs[szi];
  for(var i=0;i<bitcount;i++)
  {

    var element = document.getElementById('label'+bitcount+'_'+i);
    if (i === bitcount - 1)
    {
      element.classList.add("sign");
    }
    else if (i >= expobit[bitcount])
    {
      element.classList.add("exponent");
    }
    else
    {
      element.classList.add("mantissa");
    }
  }
}

function changed(e)
{
  var str = document.getElementById("form0").elements["num"].value;
  string = Number(str);

  try
  {
    if(str.indexOf('.') == -1)
    {
      displayInt(BigInt(str));
      updateInfo();
      return
    }
  } catch(e) {}

  displayFloat(parseFloat(string));

  updateInfo();
}

function updateInfo()
{
  for(var szi=0;szi<szs.length;szi++)
  {
    var bitcount = szs[szi];
    var uint = BigInt(0);

    for(var i=0;i<bitcount;i++)
    {
      var element = document.getElementById('b'+bitcount+'_'+i);
      
      uint += BigInt(element.innerHTML) << BigInt(i);
    }

    var statelem = document.getElementById('info'+bitcount);
    
    var array = [];
    array.push(uint + "u");
    array.push("0x" + uint.toString(16));
    array.push(intToFloat(uint, bitcount) + "f");
    //array.push("0o" + uint.toString(8));
    statelem.innerHTML = array.join(' ');
  }
}

function intToFloat(uint, bitcount)
{
  var arr = [];

  var sign = BigInt(0);
  var expo = BigInt(0);
  var mant = BigInt(0);

  var expopos = expobit[bitcount][0];
  for(var i=0;i<bitcount;i++)
  {
    var bit = (uint >> BigInt(i)) & BigInt(1);
    if (i == bitcount - 1)
    {
      sign = bit;
    }
    else if (i >= expopos)
    {
      expo += bit << BigInt(i-expopos);
    }
    else
    {
      mant += bit << BigInt(i);
    }
  }
  //console.log(sign, expo, mant);

  var exposize = bitcount - expopos - 1;
  var uexpo = (expo - 
      ( ( BigInt(2)**BigInt(exposize-1) ) - BigInt(1) ) + 
      ( ( BigInt(2)**BigInt(10        ) ) - BigInt(1) )
    ) ;

  var expomask = 0;
  for (var ei = 0; ei < exposize; ei++)
  {
    expomask = expomask << 1;
    expomask += 1;
  }

  if (expo == expomask)
  {
    uexpo = BigInt(0x7ff);
  }

  if (expo == 0 && mant == 0)
  {
    uexpo = BigInt(0);
  }

  var mantshift = 52 - (bitcount - exposize - 1);

  var csign = sign << BigInt(63);
  var cexpo = (uexpo << BigInt(52)) //+ (BigInt(1) << BigInt(52));
  var cmant = mant << BigInt(mantshift);

  var value = csign + cexpo + cmant;
  var arr = [];

  var bb = ""
  for(var i=0;i<8;i++)
  {
    var byte = Number( value >> BigInt(i*8) );
    arr.push( byte & 0xff )

    for(var bbi=0;bbi<8;bbi++)
    {
      var bit = (byte >> bbi) & 1;
      bb = bit + bb;
    }
  }

  var bytes = new Uint8Array(arr);
  console.log(["byt"+bitcount, expopos, bb, bytes, sign, expo, uexpo, mant, cmant, mantshift])
  var floatArr = new Float64Array(bytes.buffer);

  return floatArr[0];
}

function displayFloat(value)
{
  console.log('float')
  var ff = Float64Array.from([value])
  var buffer = new ArrayBuffer(ff.byteLength);
  var floatView = new Float64Array(buffer).set(ff);
  var byteView = new Uint8Array(buffer);

  //console.log("flot", byteView);

  var bits = BigInt(0);
  for(var i=0;i<8;i++)
  {
    bits += BigInt(byteView[i]) << BigInt(i*8)
  }

  var sign = bits >> BigInt(63);
  var expo = (bits >> BigInt(52)) & BigInt('0x7ff');
  var mant = bits & BigInt('0xfffffffffffff');

  //console.log(sign, expo, mant);

  for(var szi=0;szi<szs.length;szi++)
  {
    var bitcount = szs[szi];
    var exposize = bitcount - expobit[bitcount] - 1;

    var mantshift = 52 - (bitcount - exposize - 1);

    var uexpo = (expo - ((BigInt(2)**BigInt(10))-BigInt(1)) + ((BigInt(2)**BigInt(exposize-1))-BigInt(1)) );
    
    var expomask = 0;
    for (var ei = 0; ei < exposize; ei++)
    {
      expomask = expomask << 1;
      expomask += 1;
    }

    if (expo === BigInt(0x7ff))
    {
      // special case for inf and nan
      uexpo = expo & BigInt(expomask);
    }

    var csign = sign << BigInt(bitcount - 1);
    var cexpo = (uexpo) << BigInt(expobit[bitcount]);
    var cmant = mant >> BigInt(mantshift);
    var c = csign + cexpo + cmant;

    if (uexpo < 0)
    {
      c = csign + BigInt(0);
    }

    if (uexpo > expomask)
    {
      c = csign + (BigInt(expomask) << BigInt(expobit[bitcount]));
    }

    // console.log(uexpo, exposize, cmant);

    for(var i=0;i<bitcount;i++)
    {
      var num = c & BigInt(1);
      var element = document.getElementById('b'+bitcount+'_'+i);
      element.innerHTML=num;
      if (num)
      {
        element.classList.add("on");
      }
      else
      {
        element.classList.remove("on");
      }

      var element = document.getElementById('label'+bitcount+'_'+i);
      if (i === bitcount - 1)
      {
        element.classList.add("sign");
      }
      else if (i >= expobit[bitcount])
      {
        element.classList.add("exponent");
      }
      else
      {
        element.classList.add("mantissa");
      }
      c = c >> BigInt(1);
    }
  }
}

function displayInt(bits)
{
  console.log('int')
  console.log(bits);

  for(var szi=0;szi<szs.length;szi++)
  {
    var c = bits;
    for(var i=0;i<szs[szi];i++)
    {
      var num = c & BigInt(1);
      var element = document.getElementById('b'+szs[szi]+'_'+i);
      element.innerHTML=num;
      if (num)
      {
        element.classList.add("on");
      }
      else
      {
        element.classList.remove("on");
      }

      var element = document.getElementById('label'+szs[szi]+'_'+i);
      c = c >> BigInt(1);
    }
  }
}
